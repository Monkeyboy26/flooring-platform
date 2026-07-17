    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:3001'
      : `${window.location.protocol}//${window.location.hostname}:3001`;

    function getSessionId() {
      let id = localStorage.getItem('cart_session_id');
      if (!id) {
        id = 'sess_' + crypto.randomUUID();
        try { localStorage.setItem('cart_session_id', id); } catch(e) { /* quota exceeded */ }
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
        if (el) el.setAttribute('content', value || '');
      };
      setMeta('meta[name="description"]', description);
      setMeta('meta[property="og:title"]', title);
      setMeta('meta[property="og:description"]', description);
      setMeta('meta[property="og:url"]', url);
      setMeta('meta[property="og:image"]', image || '');
      setMeta('meta[name="twitter:title"]', title);
      setMeta('meta[name="twitter:description"]', description);
      setMeta('meta[name="twitter:image"]', image || '');
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
      // sell_by is authoritative; fall back to price_basis only when sell_by is unset
      if (sku.sell_by) return sku.sell_by === 'unit';
      return sku.price_basis === 'per_unit';
    }
    function isSoldPerSqyd(sku) {
      if (!sku) return false;
      if (sku.sell_by) return sku.sell_by === 'roll';
      return sku.price_basis === 'per_sqyd';
    }
    function isCarpet(sku) {
      return sku && sku.cut_price != null && sku.sell_by === 'roll';
    }
    function parseRollWidthFt(productName) {
      if (!productName) return 0;
      const m = productName.match(/(?:^|\D)(12|6(?:\.\d{1,2})?)(?:\D|$)/);
      return m ? parseFloat(m[1]) : 0;
    }
    function carpetSqftPrice(sqydPrice) {
      return (parseFloat(sqydPrice) / 9).toFixed(2);
    }
    // Parse fractional inch strings like "1-1/4\"", "9/16\"", "3/8\"" into decimal floats
    function parseFractionalInches(str) {
      if (!str || typeof str !== 'string') return NaN;
      const s = str.replace(/["″\s]/g, '').trim();
      // Whole + fraction: "1-1/4" → 1.25
      const wf = s.match(/^(\d+)[-\s](\d+)\/(\d+)$/);
      if (wf) return parseInt(wf[1]) + parseInt(wf[2]) / parseInt(wf[3]);
      // Pure fraction: "9/16" → 0.5625
      const f = s.match(/^(\d+)\/(\d+)$/);
      if (f) return parseInt(f[1]) / parseInt(f[2]);
      // Decimal or whole: "4", "1.5"
      const n = parseFloat(s);
      return isNaN(n) ? NaN : n;
    }

    function normalizeSize(val) {
      if (!val || typeof val !== 'string') return '';
      return val
        .replace(/\s*[xX×]\s*/g, 'x')       // Normalize separator to lowercase x, no spaces
        .replace(/\s+/g, ' ')                // Compact whitespace
        .replace(/\.00/g, '')                // Strip trailing .00
        .trim();
    }

    function getVariantImage(sibling, options = {}) {
      if (!sibling) return null;
      if (options.preferCountertop && sibling.countertop_image) return sibling.countertop_image;
      if (options.preferSku && sibling.sku_image) return sibling.sku_image;
      return sibling.primary_image || sibling.sku_image || sibling.shape_image || null;
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
      const unit = isFeet ? '\u2032' : '\u2033';
      return d1 + unit + ' \u00d7 ' + d2 + unit + (suffix ? ' ' + suffix : '') + (isEZ ? ' Mosaic' : '');
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
      if (isSoldPerUnit(sku)) {
        // Slab with per-sqft rate but no known area — show /sqft since piece price can't be computed
        if (sku && (sku.price_basis === 'sqft' || sku.price_basis === 'per_sqft') && !(parseFloat(sku.sqft_per_box) > 0)) {
          return '/sqft';
        }
        return '/ea';
      }
      if (isSoldPerSqyd(sku)) return '/sqyd';
      return '/sqft';
    }
    // Customer-facing list price: cut_price for carpet (per sqyd), retail_price otherwise
    function skuListPrice(sku) {
      if (!sku) return 0;
      return isCarpet(sku) ? sku.cut_price : sku.retail_price;
    }
    // Slab pricing: when price is stored per sqft but sold per piece, compute piece price
    function displayPrice(sku, rawPrice) {
      const price = parseFloat(rawPrice || 0);
      if (sku && sku.sell_by === 'unit' && (sku.price_basis === 'sqft' || sku.price_basis === 'per_sqft') && parseFloat(sku.sqft_per_box) > 0) {
        return price * parseFloat(sku.sqft_per_box);
      }
      return price;
    }

    // ==================== Image Aspect Ratio Detection ====================
    // Switches non-square product images from cover to contain so they aren't cropped
    function handleProductImgLoad(e) {
      const { naturalWidth: w, naturalHeight: h } = e.target;
      if (!w || !h) return;
      // Widen CDN intermittently serves a 300×300 "PREVIEW NOT AVAILABLE"
      // placeholder PNG instead of the real image (CloudFront edge-cache miss).
      // Detect by fixed 300×300 dims. Retry strategy:
      //   1st attempt: cache-bust with _cb param (different CDN edge)
      //   2nd attempt: request original (no w/quality — most reliably cached)
      //   3rd fail: hide the image
      const src = e.target.currentSrc || e.target.src || '';
      if (w === 300 && h === 300 && src.includes('.widen.net')) {
        const attempt = parseInt(e.target.dataset.widenRetry || '0', 10);
        if (attempt >= 2) {
          // Exhausted retries — hide it
          e.target.style.display = 'none';
          return;
        }
        e.target.dataset.widenRetry = String(attempt + 1);
        if (e.target.srcset) e.target.srcset = '';
        if (attempt === 0) {
          // 1st retry: cache-bust to hit a different CDN edge
          const clean = src.replace(/[&?]_cb=\d+/, '');
          const sep = clean.includes('?') ? '&' : '?';
          e.target.src = clean + sep + '_cb=' + Date.now();
        } else {
          // 2nd retry: request original image (no resize params)
          // The full-size original is the most reliably cached asset
          const u = new URL(src);
          u.search = '';
          e.target.src = u.toString();
        }
        return;
      }
      const r = w / h;
      if (r > 1.4 || r < 0.71) {
        e.target.style.objectFit = 'contain';
        const card = e.target.closest('.sku-card');
        if (card) card.classList.add('sku-card--contain');
      }
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
        // Cloudinary: res.cloudinary.com — insert/replace transforms after /upload/
        if (url.includes('res.cloudinary.com') && url.includes('/upload/')) {
          // Replace existing transform groups (letter_value patterns) or insert new ones
          // Stops before version segment (v1/, v2/) or asset path
          return url.replace(/\/upload\/(?:[a-z]_[^/]+\/)*/, `/upload/w_${width},f_auto,q_80/`);
        }
        // Salsify: images.salsify.com — Cloudinary-backed, insert transforms after signature
        if (url.includes('images.salsify.com') && url.includes('/upload/')) {
          return url.replace(/\/upload\/(s--[A-Za-z0-9_-]+--\/)/, `/upload/$1w_${width},f_auto,q_80/`);
        }
        // Wix static: static.wixstatic.com
        if (url.includes('static.wixstatic.com/media/')) {
          // Append /v1/fill/w_{w},h_{w},al_c,q_80/image.jpg to get a resized version
          const base = url.split('?')[0]; // strip any existing query params
          return `${base}/v1/fill/w_${width},h_${width},al_c,q_80/image.jpg`;
        }
        // Widen: *.widen.net — route through our proxy to avoid intermittent
        // CDN placeholder responses. Proxy fetches original, resizes with Sharp,
        // caches on disk, and retries on placeholder detection.
        if (url.includes('.widen.net')) {
          const u = new URL(url);
          // Strip CDN resize params — our proxy handles resizing
          u.searchParams.delete('w');
          u.searchParams.delete('h');
          u.searchParams.delete('quality');
          u.searchParams.delete('position');
          u.searchParams.delete('keep');
          u.searchParams.delete('x.app');
          return `/api/img?url=${encodeURIComponent(u.toString())}&w=${width}`;
        }
        // All other vendor domains: route through our resize proxy for
        // webp conversion, right-sizing, and nginx edge caching.
        const PROXY_DOMAINS = [
          'cdn.msisurfaces.com', 'elysiumtile.com',
          'melangetile.com', 'ragnousa.com', 'onetile.us', 'energieker.it',
          'emilgroup.it', 'platformsurfaces.com', 'lafabbrica.it',
          'cercomceramiche.it', 'supergres.com', 'onetile.it',
          'landoftile.com', 'milestonetiles.com', 'midwesttile.com',
          'domita.it', 'refin-ceramic-tiles.com', 'tilelook.com',
          'somertile.com', 'equipeceramicas.com', 'edilportale.com', 'cegoceramiche.com',
          'manningtonprod.pimcoreclient.com', 'www.hartco.com',
          'armstrongflooring.com', 'style-access.com'
        ];
        if (url.startsWith('/uploads/rom440/') || PROXY_DOMAINS.some(d => url.includes(d))) {
          return `/api/img?url=${encodeURIComponent(url)}&w=${width}`;
        }
      } catch (e) { /* malformed URL — return as-is */ }
      return url;
    }

    function optimizeSrcSet(url, sizes) {
      if (!url || typeof url !== 'string') return {};
      const srcSet = sizes.map(w => `${optimizeImg(url, w)} ${w}w`).join(', ');
      return { srcSet };
    }

    // ==================== Recent Searches (localStorage) ====================
    const RECENT_SEARCHES_KEY = 'roma_recent_searches';
    const MAX_RECENT_SEARCHES = 6;
    function getRecentSearches() {
      try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]'); } catch(e) { return []; }
    }
    function addRecentSearch(term) {
      if (!term || term.length < 2) return;
      const recent = getRecentSearches().filter(t => t.toLowerCase() !== term.toLowerCase());
      recent.unshift(term);
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES))); } catch(e) { /* quota exceeded */ }
    }
    function clearRecentSearches() { localStorage.removeItem(RECENT_SEARCHES_KEY); }

    // ==================== Search Highlight Helper ====================
    function highlightMatch(text, query) {
      if (!query || query.length < 2 || !text) return text;
      try {
        const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        const parts = String(text).split(regex);
        if (parts.length === 1) return text;
        return parts.map((part, i) => i % 2 === 1 ? React.createElement('mark', { key: i, className: 'search-highlight' }, part) : part);
      } catch(e) { return text; }
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

    // ==================== Style-to-Color-Family Map (MSI LVP + vendor-specific) ====================
    // Maps product-specific style/color names to color families.
    // Checked BEFORE keyword matching so vendor-accurate data takes priority.
    const STYLE_COLOR_MAP = {
      // --- Blonde (light warm wood tones) ---
      'Akadia': 'Blonde', 'Austell Grove': 'Blonde', 'Ayla': 'Blonde',
      'Bellamy Brooks': 'Blonde', 'Bozeman': 'Blonde', 'Bramlett': 'Blonde',
      'Brookings': 'Blonde', 'Brookline': 'Blonde',
      'Cabana': 'Blonde', 'Chester Hills': 'Blonde',
      'Coastal Cottage': 'Blonde', 'Driftway': 'Blonde',
      'Elwood': 'Blonde', 'Fallonton': 'Blonde',
      'Hatboro Hills': 'Blonde', 'Houston Trail': 'Blonde',
      'Hyde Haven': 'Blonde', 'Lark': 'Blonde',
      'Larkin': 'Blonde', 'Lazura': 'Blonde',
      'Lenexa Creek': 'Blonde', 'Mable': 'Blonde',
      'Malta': 'Blonde', 'Meadow': 'Blonde',
      'Mellshire': 'Blonde', 'Moorville': 'Blonde',
      'Northcutt': 'Blonde', 'Palmilla': 'Blonde',
      'Quillian': 'Blonde', 'Roswell': 'Blonde', 'Runmill Isle': 'Blonde',
      'Shasta Grove': 'Blonde', 'Sundelle': 'Blonde',
      'Tifton': 'Blonde', 'Tranquilla': 'Blonde',
      'Valleyview Grove': 'Blonde', 'Ventar': 'Blonde',
      'Vintaj': 'Blonde', 'Waldorf': 'Blonde', 'Wharton': 'Blonde',
      'Whitlock': 'Blonde', 'Wilton': 'Blonde',
      // Blonde overrides (keyword would give wrong family)
      'Highcliffe Greige': 'Blonde', 'Sandino': 'Blonde', 'Linen Loggia': 'Blonde',
      'Bayside Buff': 'Blonde', 'Honey Bella Oak': 'Blonde', 'Ivorelle': 'Blonde',
      'Sunny Shake': 'Blonde', 'Sunnyvale': 'Blonde',
      // --- Beige (warm neutral tones) ---
      'Baylin': 'Beige', 'Bayside Grove': 'Beige',
      'Cranton': 'Beige', 'Doack': 'Beige', 'Draven': 'Beige',
      'Woburn Abbey': 'Beige', 'Bleached Elm': 'Beige',
      // Beige overrides
      'Dunite Oak': 'Beige', 'Lime Washed Oak': 'Beige',
      // --- Brown (medium to dark wood tones) ---
      'Abingdale': 'Brown', 'Adlar': 'Brown', 'Andaz': 'Brown',
      'Ardmore Valley': 'Brown', 'Atwood': 'Brown',
      'Barnstorm': 'Brown', 'Barrell': 'Brown',
      'Beckley Bruno': 'Brown', 'Bembridge': 'Brown', 'Bergen Hills': 'Brown',
      'Billingham': 'Brown', 'Bluffview': 'Brown', 'Blythe': 'Brown',
      'Braly': 'Brown', 'Briar Haven': 'Brown', 'Brockton': 'Brown',
      'Brundinson': 'Brown', 'Chelsea Heights': 'Brown',
      'Colston Park': 'Brown', 'Delray': 'Brown', 'Dunmere': 'Brown',
      'Dunova': 'Brown', 'Exotika': 'Brown',
      'Fauna': 'Brown', 'Hatfield': 'Brown', 'Hawthorne': 'Brown',
      'Hillsdale': 'Brown', 'Hinton': 'Brown',
      'Jenta': 'Brown', 'Louise Hill': 'Brown', 'Macland': 'Brown',
      'Malden': 'Brown', 'Mesa Ridge': 'Brown', 'Millhaven': 'Brown',
      'Quercia': 'Brown', 'Roghan': 'Brown',
      'Ryder': 'Brown', 'Saddle Wood': 'Brown',
      'Scandi': 'Brown', 'Selbourne': 'Brown', 'Sequoia': 'Brown',
      'Stable': 'Brown', 'Sunnyset': 'Brown', 'Swilcan': 'Brown',
      'Taos': 'Brown', 'Thornburg': 'Brown', 'Vexton': 'Brown',
      'Waldron': 'Brown', 'Wayland': 'Brown',
      'Weathered Brina': 'Brown', 'Wixom Valley': 'Brown',
      'Wolfeboro': 'Brown', 'Timbra': 'Brown', 'Sable': 'Brown',
      // Brown overrides
      'Amber Forrester': 'Brown', 'Charcoal Oak': 'Brown',
      // --- Gray (cool tones) ---
      'Baystone': 'Gray', 'Boswell': 'Gray', 'Bourland': 'Gray',
      'Bracken Hill': 'Gray', 'Brianka': 'Gray',
      'Coastal Mix': 'Gray', 'Dakworth': 'Gray', 'Dulcet Taiga': 'Gray',
      'Emridge': 'Gray', 'Finely': 'Gray',
      'Kardigan': 'Gray', 'Liora': 'Gray', 'Loton Hill': 'Gray',
      'Ludlow': 'Gray', 'Malton': 'Gray', 'Mezcla': 'Gray',
      'Milledge': 'Gray', 'Stableton': 'Gray', 'Stormbound': 'Gray',
      'Whitmore': 'Gray',
      // Gray overrides
      'Midnight Maple': 'Gray',
      // --- White (light, marble-look, stone-look) ---
      'Calacatta Legend': 'White', 'Calacatta Marbello': 'White',
      'Calacatta Serra': 'White', 'Carrara Avell': 'White',
      'Harbor Marble': 'White', 'Quarzo Taj': 'White',
      // White overrides
      'Calacatta Venosa Gold': 'White',
      // --- Multi ---
      'Kentazza': 'Multi', 'Windsor Crest': 'Multi', 'Windsor Isle': 'Multi',
      // --- Tile-specific style names ---
      'Ice': 'White', 'Pure': 'White', 'Glacier': 'White',
      'Statuario': 'White', 'Thassos': 'White',
      'Dark': 'Gray', 'Silicon': 'Gray', 'Luna': 'Gray',
      'Iron': 'Gray', 'Shadow': 'Gray', 'Stone': 'Gray',
      'Terra': 'Brown', 'Terra Nova': 'Brown', 'Earth': 'Brown',
      'Sky': 'Blue', 'Marina': 'Blue',
      'Herringbone': null, 'Wall': null, 'Gloss': null,
      'Gloss Wall': null, 'Structured': null, 'Decorative': null,
      'Black & White': 'Multi',
      // ADEX tile colors
      'Volcanico': 'Gray', 'Monzon': 'Gray', 'Sirocco': 'Beige',
      'Poniente': 'Beige', 'Terral': 'Beige', 'Brisa': 'White',
      'Solano': 'Beige', 'Aire': 'White', 'Top Sail': 'White',
      'Glossy Cloud': 'Gray', 'Glossy Leaf': 'Green',
      // Daltile & multi-vendor tile names
      'Maestro': 'Gray', 'Bravura': 'Beige', 'Composer': 'Gray',
      'Emissary': 'Gray', 'Magistrate': 'Gray', 'Proxy': 'Gray',
      'Poise': 'Beige', 'Summit': 'Gray', 'Basin': 'Gray',
      'Wisdom': 'Beige', 'Serenity': 'White', 'Horizon': 'Gray',
      'Dama': 'Gray', 'Lugo': 'Gray', 'Astorga': 'Beige',
      'Fermi': 'Gray', 'Agnesi': 'Gray', 'Titanium': 'Gray',
      'Pismo': 'Gray', 'Trail': 'Brown',
      // --- Extended tile color names ---
      // Daltile Keystones / Color Wheel / Rittenhouse product names
      'Chalkboard': 'Gray', 'Dependable': 'Beige', 'Calm': 'Beige',
      'Balance': 'Gray', 'Restore': 'Beige', 'Spa': 'Blue',
      'Medallion': 'Beige', 'Plum Crazy': 'Red', 'Orange Burst': 'Gold',
      'Royal Purple': 'Red', 'Midnight': 'Black', 'Galaxy': 'Black',
      'Light': 'White', 'Sunburst': 'Gold', 'Parrot': 'Green',
      'Waterfall': 'Blue', 'Fresh': 'White', 'Passion': 'Red',
      'Clair': 'White', 'Cove Breeze': 'Blue', 'Cruz': 'Brown',
      'Grace': 'White', 'Legacy': 'Beige', 'Mill': 'Gray',
      'Pascal': 'Gray', 'Royal': 'Blue', 'Salt & Pepper': 'Gray',
      'Malibu': 'Blue', 'Reflexion Bright': 'White', 'Glow': 'Gold',
      'Nantes': 'Beige', 'Currant': 'Red', 'Lake': 'Blue',
      'Sea Breeze': 'Blue', 'Tundra': 'Gray', 'Eclipse': 'Black',
      'Dust': 'Beige', 'Touch Glow': 'Gold', 'Tarmac': 'Gray',
      'Toffee': 'Brown', 'Alba': 'White', 'Illusive': 'Gray',
      'Arena': 'Beige', 'Pacifica': 'Blue', 'Bella': 'Beige',
      'Desert': 'Beige', 'Artic': 'White', 'Urban Putty': 'Beige',
      // Arizona Tile product names
      'Fluida Aurea': 'Gold', 'Aequa Castor': 'Brown',
      'Tru Marmi Arabescato': 'White', 'Reverie 1': 'Beige',
      // Misc tile vendor-specific names
      'Volakas': 'White', 'Skyline': 'Gray', 'Cyber': 'Gray',
      'Petrolio': 'Blue', 'Siena': 'Brown',
      'Alpi Avana': 'Brown', 'Yang': 'White', 'Yin': 'Black',
      // More tile product names (sorted by SKU count)
      'Taj Mahal': 'Gold', 'Twilight': 'Gray', 'Dusk': 'Gray',
      'Soil': 'Brown', 'Asphalt': 'Gray', 'Verrazzo Argilla': 'Beige',
      'Talco': 'White', 'Cristallo': 'White', 'Key Lime': 'Green',
      'Shore': 'Beige', 'Magnolia': 'White', 'Riverbed': 'Gray',
      'Moon': 'Gray', 'Classic': 'Beige', 'Clear': 'White',
      'Azul': 'Blue', 'Stucco': 'Beige', 'Argent': 'Gray',
      'Current': 'Blue', 'Dawn': 'Beige', 'Diamond Mine': 'Gray',
      'Ink': 'Black', 'Mystic': 'Gray', 'Leaf': 'Green',
      'Autumn': 'Gold', 'Biscotti': 'Beige', 'Bleu': 'Blue',
      'Cliff': 'Gray', 'Ginger': 'Brown', 'Haze': 'Gray',
      'Orange': 'Gold', 'Rock': 'Gray', 'Scuro': 'Gray',
      'Pink': 'Red', 'Giallo': 'Gold', 'Calacata': 'White',
      'Bronzo': 'Gold', 'Nimbus': 'Gray', 'Buckskin': 'Brown',
      'Lotus': 'White', 'Oxide': 'Brown', 'Silt': 'Beige',
      'Shell': 'Beige', 'Spring': 'Green', 'Cove': 'Blue',
      'Composure': 'Gray', 'Allure': 'Beige', 'Aura': 'White',
      'Skyrocket': 'Blue', 'Loft': 'Gray', 'Shine': 'White',
      'Panda': 'White', 'Plume': 'White',
      // Non-color tile entries (finishes, formats, parts)
      'Shower Pan W Drain': null, 'N A': null,
      'Highlights 12x12 Db 1/8"': null, 'Polished 24x48': null,
      'Straight Joint': null, 'Up': null, 'Select': null,
      'Uplifted': null,
    };

    // Non-color values that should never map to a family
    const NON_COLOR_VALUES = new Set([
      'wall', 'gloss wall', 'gloss', 'structured', 'decorative', 'herringbone',
      'pro matt', '" pro matt', 'large', 'small', 'large ( ")', 'small ( ")',
      'n a', 'shower pan w drain', 'straight joint', 'gauged', 'polished',
      'tumbled', 'undulated', 'crackled', 'leathered', 'grip r11',
      'matte', 'gloss herringbone', 'image overlay', 'select', 'up',
      'uplifted',
    ]);

    // ==================== Color Families for Sidebar Swatches ====================
    const COLOR_FAMILIES = {
      'White':  { hex: '#f5f5f0', keywords: ['white', 'ivory', 'cream', 'snow', 'pearl', 'alabaster', 'frost', 'arctic', 'bright white', 'blanc', 'bianco', 'bianca', 'blanco', 'calacatta', 'carrara', 'chalk', 'dolomite', 'thassos', 'perla', 'perle', 'opal'] },
      'Gray':   { hex: '#9e9e9e', keywords: ['gray', 'grey', 'charcoal', 'silver', 'slate', 'ash', 'smoke', 'graphite', 'pewter', 'cement', 'concrete', 'fog', 'grigio', 'gris', 'cenere', 'steel', 'platinum', 'basalt', 'mist', 'dove', 'bardiglio', 'greige', 'lead', 'cloud', 'anthracite', 'antracita', 'argento', 'nickel', 'pebble', 'marengo', 'flint', 'shale'] },
      'Beige':  { hex: '#d4c5a9', keywords: ['beige', 'tan', 'sand', 'taupe', 'khaki', 'linen', 'wheat', 'bone', 'champagne', 'natural', 'almond', 'buff', 'crema', 'avorio', 'fawn', 'biscuit', 'dune', 'ecru', 'oyster', 'vanilla', 'nude', 'bamboo', 'lino', 'marfil', 'sabbia', 'creme', 'clay', 'putty', 'latte', 'fossil', 'travertine', 'parchment'] },
      'Brown':  { hex: '#8b6f47', keywords: ['brown', 'chocolate', 'coffee', 'mocha', 'walnut', 'chestnut', 'mahogany', 'espresso', 'umber', 'oak', 'hickory', 'pecan', 'caramel', 'acacia', 'birch', 'timber', 'tawny', 'saddle', 'jatoba', 'noce', 'cotto', 'nutmeg', 'henna', 'cafe', 'carob', 'cappuccino', 'cinnamon'] },
      'Black':  { hex: '#2c2c2c', keywords: ['black', 'onyx', 'ebony', 'jet', 'noir', 'obsidian', 'nero', 'carbon', 'coal', 'grafito', 'negro', 'marquina'] },
      'Blue':   { hex: '#6b8cae', keywords: ['blue', 'navy', 'cobalt', 'teal', 'aqua', 'sapphire', 'ocean', 'azure', 'cerulean', 'indigo', 'denim', 'cielo', 'lagoon', 'bleu'] },
      'Green':  { hex: '#7a9972', keywords: ['green', 'sage', 'olive', 'forest', 'emerald', 'moss', 'mint', 'jade', 'celadon', 'verde', 'fern', 'eucalyptus', 'salvia', 'willow'] },
      'Red':    { hex: '#b54c4c', keywords: ['red', 'burgundy', 'wine', 'cherry', 'crimson', 'maroon', 'rust', 'brick', 'terracotta', 'rose', 'blush', 'currant', 'peach'] },
      'Gold':   { hex: '#c9a668', keywords: ['gold', 'golden', 'honey', 'amber', 'copper', 'bronze', 'brass', 'oro', 'mustard', 'cornsilk', 'yellow', 'aurea', 'giallo', 'bronzo'] },
      'Blonde': { hex: '#dcc9a3', keywords: ['blonde', 'blond', 'flaxen', 'straw', 'light oak', 'light natural'] },
      'Multi':  { hex: 'conic-gradient(#f5f5f0,#9e9e9e,#d4c5a9,#8b6f47,#6b8cae)', keywords: ['multi', 'mixed', 'multicolor', 'variegated', 'blend'] },
    };

    function mapColorToFamily(rawColor) {
      if (!rawColor) return null;
      const lower = rawColor.toLowerCase().trim();
      if (!lower || lower === 'xxx' || lower === 'n/a' || lower === 'na' || lower === 'n a' || lower === 'misc.' || lower === 'misc') return null;
      if (NON_COLOR_VALUES.has(lower)) return null;
      // Skip finish+dimension values (e.g., "Polished 24x48", "Matte 24x48")
      if (/^(?:polished|honed|matte|tumbled|gauged)\s+\d/i.test(lower)) return null;
      // Check style-specific map first (vendor-accurate, overrides keywords)
      const trimmed = rawColor.trim();
      if (trimmed in STYLE_COLOR_MAP) return STYLE_COLOR_MAP[trimmed];
      // Strip common finish prefixes/suffixes and retry map
      // Handles "Matte Shadow"→"Shadow", "Stria Maestro"→"Maestro", "Willow Speckle"→"Willow"
      const base = trimmed
        .replace(/^(?:Matte|Glossy|Stria|Satin)\s+/i, '')
        .replace(/\s+Spc\s+Matte$/i, '')
        .replace(/\s+SuperGuardX\s+Technology$/i, '')
        .replace(/\s+(?:Matte|Speckle|Speckled|Spc|USA|Linen)$/i, '')
        .trim();
      if (base !== trimmed && base in STYLE_COLOR_MAP) return STYLE_COLOR_MAP[base];
      // Fall back to keyword matching on original value
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
      // Protect fraction slashes (e.g. "4-1/2") from the "/" split below
      const parts = name.replace(/(\d)\/(\d)/g, '$1\u2044$2').split(/\s*\/\s*/);
      return parts.map(part => {
        // Restore fraction slashes
        let formatted = part.replace(/(\d)\u2044(\d)/g, '$1/$2');
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
    function romanPillLabel(name) {
      if (!name) return name;
      const m = name.match(ROMAN_REGEX);
      if (!m) return name;
      // Return everything from the roman numeral onward (e.g. "II 12", "III", "IV 15")
      return name.substring(m.index).trim();
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
      // If the primary keyword (e.g. "Mosaic", "Hardwood") already appears in the name, skip
      if (words.length > 0 && new RegExp('\\b' + words[0] + '\\b', 'i').test(text)) return text;
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

    // Strip technical specs from product name for cleaner PDP h1 display
    function cleanProductTitle(name, sku) {
      if (!name) return name;
      let cleaned = name;
      // Don't strip dimensions from countertop slabs — they ARE the product identity
      const cat = (sku.category_name || '').toLowerCase();
      const isCountertop = cat.includes('countertop') || cat.includes('slab');
      if (!isCountertop) {
        // Strip trailing plank/tile dimensions: "9 X60", "7 X48", "9x60", "7x48", "12 X24"
        cleaned = cleaned.replace(/\s+\d+\s*[xX×]\s*\d+\s*$/, '');
      }
      // Strip common LVP/LVT technical spec tokens (case-insensitive, from end or mid-name)
      cleaned = cleaned.replace(/\s+SPC\b/gi, '');
      cleaned = cleaned.replace(/\s+WPC\b/gi, '');
      cleaned = cleaned.replace(/\s+W\/?\s*pad\b/gi, '');
      // Strip wear layer thickness: "20mil", "12mil", "20 mil", "6mm", "8mm"
      cleaned = cleaned.replace(/\s+\d+\s*mil\b/gi, '');
      cleaned = cleaned.replace(/\s+\d+mm\b/gi, '');
      cleaned = cleaned.trim();
      // Safety: don't strip if result is too short
      if (cleaned.length < 3) return name;
      return cleaned;
    }

    // Build a richer PDP subtitle from SKU attributes (color, size, finish)
    function pdpSubtitle(sku) {
      // Accessories: keep existing formatVariantName behavior
      if (sku.variant_type === 'accessory') return formatVariantName(sku.variant_name);
      // If variant_name already has a good compound format (contains comma → e.g. "12x24, Matte"), keep it
      if (sku.variant_name && sku.variant_name.includes(',')) return formatVariantName(sku.variant_name);

      const attrs = sku.attributes || [];
      const titleName = cleanProductTitle(sku.product_name, sku) || sku.product_name || '';
      const titleLower = titleName.toLowerCase();
      const parts = [];

      // Color — only if not already in the product title
      const colorAttr = attrs.find(a => a.slug === 'color');
      if (colorAttr && colorAttr.value) {
        const colorVal = formatCarpetValue(colorAttr.value);
        if (!titleLower.includes(colorVal.toLowerCase())) {
          parts.push(colorVal);
        }
      }

      // Size — formatted with inch/foot marks
      const sizeAttr = attrs.find(a => a.slug === 'size');
      if (sizeAttr && sizeAttr.value) {
        parts.push(formatSizeDim(sizeAttr.value));
      }

      // Finish — if available and not redundant with title
      const finishAttr = attrs.find(a => a.slug === 'finish');
      if (finishAttr && finishAttr.value) {
        const finishVal = formatCarpetValue(finishAttr.value);
        if (!titleLower.includes(finishVal.toLowerCase())) {
          parts.push(finishVal);
        }
      }

      // Fall back to variant_name if no attributes built anything
      if (parts.length === 0) return formatVariantName(sku.variant_name);
      return parts.join(', ');
    }

    function fullProductName(sku) {
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

      // Append format label (e.g. "4x8", "Hex", "Rombo") for format-grouped products
      if (sku.format_label) {
        name = name + ' ' + sku.format_label;
      }

      // Vendors that use collection as a browsing taxonomy (not a product-line prefix)
      // e.g. Bellezza's "Marble Look", "Concrete & Industrial" are grouping concepts, not product names
      const TAXONOMY_COLLECTION_VENDORS = new Set(['BELLEZZA']);
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
          const isAdexVendor = (sku.vendor_code || '').toUpperCase() === 'ADEX';
          const sizeAttr = rawSizeAttr && !isAdexVendor && (
            /^\d+\s*[xX×]\s*\d+\s*ft$/i.test(rawSizeVal) ||
            /^\d+\.\d+\s*[xX×]\s*\d+\.\d+$/.test(rawSizeVal) ||
            /^\d+\.\d+\s+Wide$/i.test(rawSizeVal) ||
            /^\d+\s+in$/i.test(rawSizeVal) ||
            /^\d+\u2033$/.test(rawSizeVal)
          ) ? null : rawSizeAttr;
          const patternAttr = (sku.attributes || []).find(a => a.slug === 'pattern');
          const finishAttr = (sku.attributes || []).find(a => a.slug === 'finish');
          const nameLowerDedup = name.toLowerCase();
          const extras = [patternAttr, sizeAttr]
            .filter(Boolean)
            .filter(a => !nameLowerDedup.includes(a.value.toLowerCase()))
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
              if (colLc && name.toLowerCase().startsWith(colLc + ' ')) {
                name = name.slice(0, col.length) + (colorVal ? ' ' + colorVal : '') + ' ' + sizePart + name.slice(col.length);
                if (colorVal) variant = null;
              } else {
                variant = (colorVal ? colorVal + ' ' : '') + sizePart;
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

    function StockBadge({ status, vendorHasInventory, qtyOnHand, qtyOnHandSqft, sellBy }) {
      if (vendorHasInventory === false && (status === 'unknown' || status === 'out_of_stock')) {
        return React.createElement('div', { className: 'pdp-stock-badge out-of-stock' },
          React.createElement('span', { className: 'pdp-stock-dot' }),
          'Call for availability'
        );
      }
      let lowStockLabel = 'Low Stock \u2014 Order Soon';
      if (status === 'low_stock' && qtyOnHand != null && qtyOnHand > 0) {
        if (sellBy === 'unit') {
          lowStockLabel = 'Only ' + qtyOnHand + ' left \u2014 Order Soon';
        } else if (sellBy === 'box' && qtyOnHandSqft) {
          lowStockLabel = 'Only ' + qtyOnHand + ' boxes left (' + Math.round(qtyOnHandSqft) + ' sqft) \u2014 Order Soon';
        } else if (sellBy === 'roll') {
          lowStockLabel = 'Only ' + (qtyOnHandSqft ? Math.round(qtyOnHandSqft) + ' sqft' : qtyOnHand + ' rolls') + ' left \u2014 Order Soon';
        } else {
          lowStockLabel = 'Only ' + qtyOnHand + ' left \u2014 Order Soon';
        }
      }
      const map = {
        in_stock: { label: 'In Stock', cls: 'in-stock' },
        low_stock: { label: lowStockLabel, cls: 'low-stock' },
        out_of_stock: { label: 'Out of Stock', cls: 'out-of-stock' },
        discontinued: { label: 'Discontinued', cls: 'discontinued' },
      };
      const info = map[status] || { label: 'Check Availability', cls: 'out-of-stock' };
      return React.createElement('div', { className: `pdp-stock-badge ${info.cls}` },
        React.createElement('span', { className: 'pdp-stock-dot' }),
        info.label
      );
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
    let _stripeInitPromise = null;
    // Stripe.js loads async and can finish after this bundle executes, so
    // initialization waits for it instead of bailing on a lost race.
    function ensureStripe() {
      if (stripeInstance) return Promise.resolve(stripeInstance);
      if (_stripeInitPromise) return _stripeInitPromise;
      _stripeInitPromise = (async () => {
        for (let i = 0; i < 100 && typeof Stripe === 'undefined'; i++) {
          await new Promise(r => setTimeout(r, 100));
        }
        if (typeof Stripe === 'undefined') { _stripeInitPromise = null; return null; }
        try {
          const r = await fetch((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3001' : '') + '/api/config/stripe-key');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          if (data.key) stripeInstance = Stripe(data.key);
        } catch (e) {
          console.warn('Failed to load Stripe key:', e);
          _stripeInitPromise = null;
        }
        return stripeInstance;
      })();
      return _stripeInitPromise;
    }
    ensureStripe();

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

    // ==================== Cabinets Page ====================

    function materialFace(kind, tone) {
      const T = tone || {};
      const A = T.a || '#c8b094';
      const B = T.b || '#7a6850';
      const C = T.c || '#3a3127';
      switch (kind) {
        case 'wood':
          return { background: `repeating-linear-gradient(92deg, ${A} 0 7px, ${B} 7px 9px, ${A} 9px 22px, ${C}55 22px 23px, ${A} 23px 41px, ${B} 41px 43px), linear-gradient(180deg, ${A}, ${B})`, backgroundBlendMode: 'multiply' };
        case 'marble':
          return { background: `radial-gradient(120% 80% at 30% 20%, ${A} 0%, ${A} 30%, ${B}88 55%, ${A} 70%), radial-gradient(80% 60% at 70% 80%, ${C}55, transparent 60%), linear-gradient(135deg, ${A}, ${B}44)` };
        case 'tile':
          return { background: `repeating-linear-gradient(0deg, ${C}22 0 0.5px, transparent 0.5px 60px), repeating-linear-gradient(90deg, ${C}22 0 0.5px, transparent 0.5px 60px), radial-gradient(60% 80% at 40% 30%, ${A}, ${B})` };
        case 'stone':
          return { background: `radial-gradient(40% 60% at 25% 30%, ${A}, ${B} 80%), radial-gradient(30% 30% at 70% 60%, ${A}88, transparent), radial-gradient(20% 20% at 50% 80%, ${C}55, transparent), ${B}` };
        case 'lvp':
          return { background: `repeating-linear-gradient(95deg, ${A} 0 14px, ${B}77 14px 15px, ${A} 15px 30px), linear-gradient(180deg, ${A}, ${B})`, backgroundBlendMode: 'multiply' };
        case 'quartz':
          return { background: `radial-gradient(2px 2px at 20% 30%, ${C}55, transparent), radial-gradient(2px 2px at 60% 20%, ${C}55, transparent), radial-gradient(3px 3px at 80% 60%, ${C}77, transparent), radial-gradient(2px 2px at 30% 70%, ${C}55, transparent), radial-gradient(2px 2px at 50% 50%, ${C}55, transparent), linear-gradient(135deg, ${A}, ${B}44)` };
        default:
          return { background: A };
      }
    }

    const CAB_BRANDS = {
      waypoint: {
        id: 'waypoint', name: 'Waypoint', tagline: 'Living Spaces',
        origin: 'Cumberland, MD · American Woodmark', framing: 'framed',
        framingLabel: 'Face-frame construction',
        framingNote: 'Traditional American build. Visible frame around the door opening keeps fronts perfectly aligned for decades.',
        pitch: 'Painted maple and stained oak, built by hand in the United States — soft-close standard, dent-resistant UV-catalytic paint, lifetime warranty.',
        bestFor: 'Classic · Transitional · Traditional kitchens',
        doors: [
          { id: 'shaker',   name: 'Hawthorne Shaker',   profile: 'shaker' },
          { id: 'recessed', name: 'Maple Recessed',     profile: 'recessed' },
          { id: 'raised',   name: 'Sonoma Raised',      profile: 'raised' },
          { id: 'beaded',   name: 'Linen Beaded',       profile: 'beaded' },
          { id: 'arch',     name: 'Hartwell Arched',    profile: 'arched' },
          { id: 'mullion',  name: 'Vienna Mullion',     profile: 'mullion' },
        ],
        finishes: [
          { id: 'white',    name: 'Painted White',    family: 'painted', fill: '#f7f2e8' },
          { id: 'linen',    name: 'Painted Linen',    family: 'painted', fill: '#f1ebd9' },
          { id: 'oat',      name: 'Painted Oat',      family: 'painted', fill: '#e3d8b8' },
          { id: 'hazelnut', name: 'Painted Hazelnut', family: 'painted', fill: '#c9b694' },
          { id: 'sage',     name: 'Painted Sage',     family: 'painted', fill: '#a8b095' },
          { id: 'fern',     name: 'Painted Fern',     family: 'painted', fill: '#7a8769' },
          { id: 'olive',    name: 'Painted Olive',    family: 'painted', fill: '#56603e' },
          { id: 'bluestone',name: 'Painted Bluestone',family: 'painted', fill: '#6a7a85' },
          { id: 'slate',    name: 'Painted Slate',    family: 'painted', fill: '#3e4856' },
          { id: 'cinnamon', name: 'Painted Cinnamon', family: 'painted', fill: '#a26a4a' },
          { id: 'charcoalp',name: 'Painted Charcoal', family: 'painted', fill: '#33312e' },
          { id: 'black',    name: 'Painted Black',    family: 'painted', fill: '#1a1815' },
          { id: 'natmaple', name: 'Natural Maple',    family: 'stained', species: 'maple',   fill: '#d9b988', wood: true, tone: { a: '#d9b988', b: '#a07d4e', c: '#5a4022' } },
          { id: 'cider',    name: 'Maple Cider',      family: 'stained', species: 'maple',   fill: '#a87b4a', wood: true, tone: { a: '#caa97f', b: '#7a5635', c: '#3a2814' } },
          { id: 'cocoa',    name: 'Maple Cocoa',      family: 'stained', species: 'maple',   fill: '#704024', wood: true, tone: { a: '#8a5e3a', b: '#4a2818', c: '#1c0e07' } },
          { id: 'espresso', name: 'Maple Espresso',   family: 'stained', species: 'maple',   fill: '#3a2418', wood: true, tone: { a: '#5a3a26', b: '#2a1c12', c: '#0a0604' } },
          { id: 'natural',  name: 'Natural Oak',      family: 'stained', species: 'oak',     fill: '#caa97f', wood: true, tone: { a: '#caa97f', b: '#7a5635', c: '#3a2814' } },
          { id: 'honey',    name: 'Honey Oak',        family: 'stained', species: 'oak',     fill: '#b8884c', wood: true, tone: { a: '#b8884c', b: '#7a5424', c: '#3a280a' } },
          { id: 'saddle',   name: 'Saddle Oak',       family: 'stained', species: 'oak',     fill: '#8a5d2e', wood: true, tone: { a: '#a86e3a', b: '#6a3c16', c: '#2a1c08' } },
          { id: 'coffee',   name: 'Coffee Oak',       family: 'stained', species: 'oak',     fill: '#4a2e1a', wood: true, tone: { a: '#6e4a30', b: '#3e2412', c: '#1a0e06' } },
          { id: 'cherry',   name: 'Aged Cherry',      family: 'stained', species: 'cherry',  fill: '#8a4a30', wood: true, tone: { a: '#a86848', b: '#5a3018', c: '#2a140a' } },
          { id: 'bordeaux', name: 'Bordeaux Cherry',  family: 'stained', species: 'cherry',  fill: '#5a2418', wood: true, tone: { a: '#7a3624', b: '#3a160c', c: '#180806' } },
          { id: 'hickory',  name: 'Natural Hickory',  family: 'stained', species: 'hickory', fill: '#bf9670', wood: true, tone: { a: '#d4b08a', b: '#6a4226', c: '#2a1a0e' } },
          { id: 'smoked',   name: 'Smoked Hickory',   family: 'stained', species: 'hickory', fill: '#5a4632', wood: true, tone: { a: '#7a5e44', b: '#3a2c1e', c: '#1a120c' } },
          { id: 'charcoal', name: 'Charcoal Stain',   family: 'stained', species: 'oak',     fill: '#3a3530', wood: true, tone: { a: '#5a5048', b: '#2a241e', c: '#0a0808' } },
        ],
        hardware: [
          { id: 'knob', name: 'Round Knob' },
          { id: 'bar',  name: 'Bar Pull' },
          { id: 'cup',  name: 'Cup Pull' },
        ],
        defaults: { door: 'shaker', finish: 'linen', hardware: 'knob' },
        warranty: 'Lifetime', lead: '5–7 weeks', startingAt: '$240 / lf',
        stat: { v: '420+', l: 'Sample doors stocked' },
      },
      europa: {
        id: 'europa', name: 'Europa', tagline: 'Cabinetry',
        origin: 'Italian-engineered', framing: 'frameless',
        framingLabel: 'Frameless full-access',
        framingNote: 'No face frame. Doors and drawers mount directly to the box, returning ~15% of the interior to you.',
        pitch: 'Slab fronts, integrated handles, push-to-open and soft-close throughout. Every appliance can be panel-ready.',
        bestFor: 'Modern · Contemporary · Minimal kitchens',
        doors: [
          { id: 'slab',    name: 'Linea Slab',        profile: 'slab' },
          { id: 'channel', name: 'Vetro Channel',     profile: 'channel' },
          { id: 'slim',    name: 'Atmosfera Slim',    profile: 'slim' },
          { id: 'gloss',   name: 'Tribeca High-Gloss',profile: 'slab', sheen: 'gloss' },
          { id: 'reeded',  name: 'Onda Reeded',       profile: 'reeded' },
          { id: 'glass',   name: 'Vetrina Glass',     profile: 'glass' },
        ],
        finishes: [
          { id: 'snow',     name: 'Snow Matte',       family: 'matte',  fill: '#ece8df' },
          { id: 'ivory',    name: 'Ivory Matte',      family: 'matte',  fill: '#e8dfc8' },
          { id: 'linenm',   name: 'Linen Matte',      family: 'matte',  fill: '#d8ccb2' },
          { id: 'sand',     name: 'Sand Matte',       family: 'matte',  fill: '#cbbf9e' },
          { id: 'stone',    name: 'Stone Matte',      family: 'matte',  fill: '#a59f8a' },
          { id: 'sagem',    name: 'Sage Matte',       family: 'matte',  fill: '#8e9a82' },
          { id: 'olivem',   name: 'Olive Matte',      family: 'matte',  fill: '#5e6644' },
          { id: 'fog',      name: 'Fog Grey',         family: 'matte',  fill: '#9aa0a3' },
          { id: 'cement',   name: 'Cement',           family: 'matte',  fill: '#666560' },
          { id: 'graphite', name: 'Graphite',         family: 'matte',  fill: '#2a2c2e' },
          { id: 'carbon',   name: 'Carbon Matte',     family: 'matte',  fill: '#16171a' },
          { id: 'cobalt',   name: 'Cobalt Matte',     family: 'matte',  fill: '#2c3a5e' },
          { id: 'terracotta',name: 'Terracotta Matte',family: 'matte',  fill: '#a85838' },
          { id: 'bordeauxm',name: 'Bordeaux Matte',   family: 'matte',  fill: '#5a2424' },
          { id: 'glosswhite', name: 'High-Gloss White', family: 'gloss', fill: '#fafaf5' },
          { id: 'glossblack', name: 'High-Gloss Black', family: 'gloss', fill: '#16171a' },
          { id: 'glosspearl', name: 'High-Gloss Pearl', family: 'gloss', fill: '#e8e4d8' },
          { id: 'oakv',     name: 'White Oak Veneer', family: 'veneer', species: 'oak',     fill: '#caa97f', wood: true, tone: { a: '#caa97f', b: '#7a5635', c: '#3a2814' } },
          { id: 'walnut',   name: 'Walnut Veneer',    family: 'veneer', species: 'walnut',  fill: '#6a3818', wood: true, tone: { a: '#8a5e3a', b: '#4a2818', c: '#1c0e07' } },
          { id: 'smokedv',  name: 'Smoked Oak Veneer',family: 'veneer', species: 'oak',     fill: '#3a2e22', wood: true, tone: { a: '#5a4a36', b: '#2c1f14', c: '#0e0806' } },
          { id: 'cerused',  name: 'Cerused Oak',      family: 'veneer', species: 'oak',     fill: '#b8a890', wood: true, tone: { a: '#d4c4a8', b: '#8a7e64', c: '#3a3424' } },
          { id: 'beton',    name: 'Béton Concrete',   family: 'textured', fill: '#8a8682' },
          { id: 'brass',    name: 'Patina Brass',     family: 'textured', fill: '#a87a3a' },
        ],
        hardware: [
          { id: 'integrated', name: 'Integrated Channel' },
          { id: 'bar',        name: 'Slim Bar Pull' },
          { id: 'none',       name: 'Push-to-Open' },
        ],
        defaults: { door: 'slab', finish: 'snow', hardware: 'integrated' },
        warranty: '10-year', lead: '4–6 weeks', startingAt: '$320 / lf',
        stat: { v: '+15%', l: 'Accessible interior' },
      },
    };

    function cabBtn(bg, fg, kind, theme) {
      if (kind === 'primary') return {
        padding: '14px 22px', background: bg, color: fg, border: 'none', borderRadius: 999,
        font: '500 12px/1 var(--font-body)', letterSpacing: '0.08em', textTransform: 'uppercase',
        cursor: 'pointer', whiteSpace: 'nowrap', transition: 'opacity 0.2s, transform 0.2s',
      };
      return {
        padding: '13px 21px', background: 'transparent', color: theme.ink,
        border: `0.5px solid ${theme.ink}33`, borderRadius: 999,
        font: '500 12px/1 var(--font-body)', letterSpacing: '0.08em', textTransform: 'uppercase',
        cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background 0.2s, color 0.2s, border-color 0.2s',
      };
    }

    function CabSectionHead({ theme, num, eyebrow, headline, sub, align = 'left' }) {
      const { ink, accent, muted } = theme;
      return (
        <div style={{ textAlign: align, marginBottom: 56 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 14,
            font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.22em',
            textTransform: 'uppercase', color: muted, marginBottom: 22,
          }}>
            <span style={{ color: accent }}>{num}</span>
            <span style={{ width: 24, height: 1, background: `${ink}22` }} />
            <span>{eyebrow}</span>
          </div>
          <h2 style={{
            font: '300 56px/1.18 var(--font-heading)', margin: 0,
            letterSpacing: '-0.018em', textWrap: 'pretty', color: ink,
          }}>{headline}</h2>
          {sub && (
            <p style={{
              font: '400 17px/1.55 var(--font-body)', color: `${ink}dd`,
              margin: '36px 0 0', maxWidth: 640,
              ...(align === 'center' ? { marginLeft: 'auto', marginRight: 'auto' } : {}),
            }}>{sub}</p>
          )}
        </div>
      );
    }

    function CabinetSpecimen({ theme, brand, door, finish, hardware, softClose, big }) {
      const { ink, paper, accent, muted } = theme;
      const B = CAB_BRANDS[brand];
      const D = B.doors.find(d => d.id === door) || B.doors[0];
      const F = B.finishes.find(f => f.id === finish) || B.finishes[0];
      const H = B.hardware.find(h => h.id === hardware) || B.hardware[0];
      const framed = B.framing === 'framed';
      const gloss = D.sheen === 'gloss' || F.family === 'gloss';
      const VB_W = 640, VB_H = 720;
      const X0 = 30, X1 = 610, Y0 = 50, Y1 = 660;
      const FR = framed ? 18 : 2;
      const DR_Y0 = Y0 + FR, DR_Y1 = DR_Y0 + 100;
      const DOORS_Y0 = DR_Y1 + FR, DOORS_Y1 = Y1 - FR;
      const MIDX = (X0 + X1) / 2;
      const finishFillId = `cab-fill-${brand}-${F.id}-${gloss ? 'g' : 'm'}`;
      const woodPatternId = `cab-wood-${brand}-${F.id}`;
      const useWood = !!F.wood;
      const faceFill = useWood ? `url(#${woodPatternId})` : `url(#${finishFillId})`;

      const renderDoor = (x0, y0, x1, y1, isDrawer) => (
        <g key={`${x0}-${y0}`}>
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={faceFill} stroke={ink} strokeOpacity="0.18" strokeWidth="0.5" />
          {gloss && <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={`url(#${finishFillId}-gloss)`} />}
          {F.family === 'textured' && <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="url(#cab-texture-noise)" opacity="0.4" />}
          {(D.profile === 'shaker' || D.profile === 'recessed' || D.profile === 'slim') && (() => {
            const inset = D.profile === 'slim' ? 10 : (D.profile === 'shaker' ? 26 : 22);
            const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? Math.min(inset, 14) : inset);
            const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? Math.min(inset, 14) : inset);
            return (<g>
              <rect x={ix0} y={iy0} width={ix1 - ix0} height={iy1 - iy0} fill="rgba(0,0,0,0.06)" />
              <line x1={ix0} y1={iy0} x2={ix1} y2={iy0} stroke="rgba(0,0,0,0.18)" strokeWidth="0.7" />
              <line x1={ix0} y1={iy0} x2={ix0} y2={iy1} stroke="rgba(0,0,0,0.14)" strokeWidth="0.7" />
              <line x1={ix1} y1={iy0} x2={ix1} y2={iy1} stroke="rgba(255,255,255,0.35)" strokeWidth="0.5" />
              <line x1={ix0} y1={iy1} x2={ix1} y2={iy1} stroke="rgba(255,255,255,0.35)" strokeWidth="0.5" />
            </g>);
          })()}
          {D.profile === 'raised' && (() => {
            const inset = 22;
            const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? 12 : inset);
            const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? 12 : inset);
            const ch = 14;
            return (<g>
              <polygon points={`${ix0+ch},${iy0+ch} ${ix1-ch},${iy0+ch} ${ix1-ch},${iy1-ch} ${ix0+ch},${iy1-ch}`} fill="rgba(255,255,255,0.18)" />
              <polygon points={`${ix0},${iy0} ${ix1},${iy0} ${ix1-ch},${iy0+ch} ${ix0+ch},${iy0+ch}`} fill="rgba(255,255,255,0.18)" />
              <polygon points={`${ix0},${iy1} ${ix1},${iy1} ${ix1-ch},${iy1-ch} ${ix0+ch},${iy1-ch}`} fill="rgba(0,0,0,0.16)" />
              <polygon points={`${ix0},${iy0} ${ix0+ch},${iy0+ch} ${ix0+ch},${iy1-ch} ${ix0},${iy1}`} fill="rgba(0,0,0,0.08)" />
              <polygon points={`${ix1},${iy0} ${ix1-ch},${iy0+ch} ${ix1-ch},${iy1-ch} ${ix1},${iy1}`} fill="rgba(255,255,255,0.08)" />
            </g>);
          })()}
          {D.profile === 'beaded' && (() => {
            const inset = 18;
            const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? 10 : inset);
            const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? 10 : inset);
            return (<g>
              <rect x={ix0} y={iy0} width={ix1 - ix0} height={iy1 - iy0} fill="rgba(0,0,0,0.04)" />
              <rect x={ix0 + 6} y={iy0 + 6} width={ix1 - ix0 - 12} height={iy1 - iy0 - 12} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" />
              <rect x={ix0 + 8} y={iy0 + 8} width={ix1 - ix0 - 16} height={iy1 - iy0 - 16} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
            </g>);
          })()}
          {D.profile === 'channel' && (<g>
            <rect x={x0} y={y0} width={x1 - x0} height={10} fill="rgba(0,0,0,0.32)" />
            <rect x={x0 + 4} y={y0 + 2} width={x1 - x0 - 8} height={6} fill="rgba(0,0,0,0.45)" />
          </g>)}
          {D.profile === 'reeded' && (() => {
            const w = x1 - x0;
            const count = Math.max(10, Math.floor(w / 14));
            const step = w / count;
            return (<g>
              {Array.from({ length: count + 1 }).map((_, i) => <line key={i} x1={x0 + i * step} y1={y0 + 2} x2={x0 + i * step} y2={y1 - 2} stroke="rgba(0,0,0,0.18)" strokeWidth="0.6" />)}
              {Array.from({ length: count }).map((_, i) => <line key={`h${i}`} x1={x0 + i * step + step / 2} y1={y0 + 4} x2={x0 + i * step + step / 2} y2={y1 - 4} stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />)}
            </g>);
          })()}
          {D.profile === 'glass' && !isDrawer && (() => {
            const ix0 = x0 + 14, iy0 = y0 + 14, ix1 = x1 - 14, iy1 = y1 - 14;
            const midX = (ix0 + ix1) / 2, midY = (iy0 + iy1) / 2;
            return (<g stroke="rgba(0,0,0,0.28)" strokeWidth="1" fill="rgba(255,255,255,0.18)">
              <rect x={ix0} y={iy0} width={ix1 - ix0} height={iy1 - iy0} />
              <line x1={midX} y1={iy0} x2={midX} y2={iy1} />
              <line x1={ix0} y1={midY} x2={ix1} y2={midY} />
              <line x1={ix0 + 12} y1={iy0 + 12} x2={ix0 + 60} y2={iy0 + 60} stroke="rgba(255,255,255,0.45)" strokeWidth="1" />
            </g>);
          })()}
          {D.profile === 'mullion' && !isDrawer && (() => {
            const ix0 = x0 + 16, iy0 = y0 + 16, ix1 = x1 - 16, iy1 = y1 - 16;
            return (<g stroke="rgba(0,0,0,0.3)" strokeWidth="1.2" fill="rgba(0,0,0,0.06)">
              <rect x={ix0} y={iy0} width={ix1 - ix0} height={iy1 - iy0} />
              <line x1={(ix0 + ix1) / 2} y1={iy0} x2={(ix0 + ix1) / 2} y2={iy1} strokeWidth="1" />
              <line x1={ix0} y1={(iy0 + iy1) / 2} x2={ix1} y2={(iy0 + iy1) / 2} strokeWidth="1" />
            </g>);
          })()}
          {D.profile === 'arched' && !isDrawer && (() => {
            const inset = 18;
            const ix0 = x0 + inset, ix1 = x1 - inset, iy1 = y1 - inset;
            const arcStartY = y0 + 80;
            const path = `M ${ix0} ${iy1} L ${ix0} ${arcStartY} Q ${ix0} ${y0 + inset} ${(ix0 + ix1) / 2} ${y0 + inset} Q ${ix1} ${y0 + inset} ${ix1} ${arcStartY} L ${ix1} ${iy1} Z`;
            return <path d={path} fill="rgba(0,0,0,0.06)" stroke="rgba(0,0,0,0.22)" strokeWidth="0.7" />;
          })()}
        </g>
      );

      const renderHardware = (cx, cy, kind) => {
        if (kind === 'none' || kind === 'integrated') return null;
        if (kind === 'knob') return <circle cx={cx} cy={cy} r="5" fill={ink} />;
        if (kind === 'bar') return <rect x={cx - 40} y={cy - 3} width="80" height="6" rx="3" fill={ink} />;
        if (kind === 'cup') return (<g>
          <path d={`M ${cx - 32} ${cy - 4} L ${cx - 32} ${cy + 6} Q ${cx} ${cy + 14}, ${cx + 32} ${cy + 6} L ${cx + 32} ${cy - 4} Z`} fill={ink} fillOpacity="0.85" />
          <rect x={cx - 32} y={cy - 5} width="64" height="3" fill={ink} />
        </g>);
        return null;
      };

      return (
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ width: '100%', height: '100%', display: 'block' }}>
          <defs>
            <linearGradient id={finishFillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={F.fill} stopOpacity="1" />
              <stop offset="60%" stopColor={F.fill} stopOpacity="1" />
              <stop offset="100%" stopColor={F.fill} stopOpacity={F.family === 'matte' ? 0.94 : 1} />
            </linearGradient>
            <linearGradient id={`${finishFillId}-gloss`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
              <stop offset="35%" stopColor="rgba(255,255,255,0.05)" />
              <stop offset="65%" stopColor="rgba(0,0,0,0.05)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
            </linearGradient>
            {F.wood && (
              <pattern id={woodPatternId} patternUnits="userSpaceOnUse" width="80" height="16" patternTransform="rotate(90)">
                <rect width="80" height="16" fill={F.tone.a} />
                <rect x="0" y="5" width="80" height="0.8" fill={F.tone.c} opacity="0.55" />
                <rect x="0" y="11" width="80" height="0.6" fill={F.tone.c} opacity="0.35" />
                <rect x="0" y="2" width="80" height="0.4" fill={F.tone.b} opacity="0.45" />
                <rect x="0" y="0" width="0.6" height="16" fill={F.tone.c} opacity="0.4" />
                <rect x="38" y="0" width="0.6" height="16" fill={F.tone.c} opacity="0.32" />
                <ellipse cx="60" cy="8" rx="6" ry="3" fill={F.tone.b} opacity="0.22" />
              </pattern>
            )}
            <pattern id="cab-texture-noise" patternUnits="userSpaceOnUse" width="8" height="8">
              <rect width="8" height="8" fill="none" />
              <circle cx="2" cy="3" r="0.6" fill="rgba(0,0,0,0.5)" />
              <circle cx="6" cy="5" r="0.5" fill="rgba(255,255,255,0.35)" />
              <circle cx="4" cy="7" r="0.4" fill="rgba(0,0,0,0.3)" />
            </pattern>
            <pattern id="cab-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke={ink} strokeWidth="0.5" strokeOpacity="0.55" />
            </pattern>
          </defs>
          <rect x="0" y="0" width={VB_W} height="38" fill={`${ink}11`} />
          <rect x="0" y="38" width={VB_W} height="6" fill={ink} />
          <line x1="0" y1="44" x2={VB_W} y2="44" stroke={paper} strokeWidth="2" />
          <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} fill={ink} fillOpacity="0.04" />
          {framed && (<g fill="url(#cab-hatch)">
            <rect x={X0} y={Y0} width={FR} height={Y1 - Y0} />
            <rect x={X1 - FR} y={Y0} width={FR} height={Y1 - Y0} />
            <rect x={X0} y={Y0} width={X1 - X0} height={FR} />
            <rect x={X0} y={DR_Y1} width={X1 - X0} height={FR} />
            <rect x={X0} y={Y1 - FR} width={X1 - X0} height={FR} />
            <rect x={MIDX - FR / 2} y={DOORS_Y0} width={FR} height={DOORS_Y1 - DOORS_Y0} />
          </g>)}
          {framed ? renderDoor(X0 + FR, DR_Y0, X1 - FR, DR_Y1, true) : renderDoor(X0 + 2, DR_Y0, X1 - 2, DR_Y1, true)}
          {framed ? renderDoor(X0 + FR, DOORS_Y0, MIDX - FR / 2, DOORS_Y1, false) : renderDoor(X0 + 2, DOORS_Y0, MIDX - 2, DOORS_Y1, false)}
          {framed ? renderDoor(MIDX + FR / 2, DOORS_Y0, X1 - FR, DOORS_Y1, false) : renderDoor(MIDX + 2, DOORS_Y0, X1 - 2, DOORS_Y1, false)}
          {(H.id !== 'integrated' && H.id !== 'none' && D.profile !== 'channel') && renderHardware((X0 + X1) / 2, (DR_Y0 + DR_Y1) / 2, H.id)}
          {(H.id !== 'integrated' && H.id !== 'none' && D.profile !== 'channel') && (() => {
            const door1x = MIDX - FR / 2 - (H.id === 'knob' ? 24 : 70);
            const door2x = MIDX + FR / 2 + (H.id === 'knob' ? 24 : 70);
            const knobY = DOORS_Y0 + 60;
            if (H.id === 'knob') return (<g>{renderHardware(door1x, knobY, 'knob')}{renderHardware(door2x, knobY, 'knob')}</g>);
            const x1c = MIDX - FR / 2 - 22, x2c = MIDX + FR / 2 + 22;
            const hy0 = DOORS_Y0 + 40, hy1 = hy0 + 100;
            return (<g>
              <rect x={x1c - 3} y={hy0} width="6" height={hy1 - hy0} rx="3" fill={ink} />
              <rect x={x2c - 3} y={hy0} width="6" height={hy1 - hy0} rx="3" fill={ink} />
            </g>);
          })()}
          <rect x={X0 + 12} y={Y1} width={X1 - X0 - 24} height={VB_H - Y1 - 4} fill={ink} fillOpacity="0.6" />
          <rect x="0" y={VB_H - 4} width={VB_W} height="4" fill={ink} fillOpacity="0.12" />
          <g fill={ink} fillOpacity="0.45" fontFamily="ui-monospace, monospace" fontSize="9" letterSpacing="0.16em">
            <text x={X0} y={VB_H - 14} stroke="none">36&quot; W · 34.5&quot; H · 24&quot; D</text>
            <text x={X1} y={VB_H - 14} stroke="none" textAnchor="end">{B.framingLabel.toUpperCase()}</text>
          </g>
          {softClose && (<g>
            <rect x={X1 - 168} y={Y0 + 14} width="146" height="22" rx="11" fill={paper} stroke={accent} strokeWidth="0.5" />
            <circle cx={X1 - 154} cy={Y0 + 25} r="3" fill={accent} />
            <text x={X1 - 144} y={Y0 + 28} fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} stroke="none">SOFT-CLOSE ACTIVE</text>
          </g>)}
          <g>
            <rect x="0" y={VB_H - 30} width="120" height="22" fill={ink} />
            <text x="14" y={VB_H - 14} fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="0.18em" fill={paper} stroke="none">{B.name.toUpperCase()}</text>
          </g>
        </svg>
      );
    }

    function CabBrandTile({ theme, B, selected, onPick }) {
      const { ink, paper, accent, muted } = theme;
      const [hover, setHover] = useState(false);
      const lift = !selected && hover;
      return (
        <button onClick={onPick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
          position: 'relative', textAlign: 'left', cursor: 'pointer',
          background: selected ? paper : `${ink}03`,
          border: 'none', borderTop: `3px solid ${selected ? accent : ink + '22'}`,
          padding: 0, transition: 'all .25s',
          transform: lift ? 'translateY(-3px)' : 'none',
          boxShadow: selected ? `0 24px 60px ${ink}22, 0 0 0 0.5px ${ink}22` : lift ? `0 12px 32px ${ink}18, 0 0 0 0.5px ${ink}22` : `0 0 0 0.5px ${ink}11`,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', height: 420 }}>
            <div style={{ padding: '36px 32px 32px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: selected ? accent : muted, marginBottom: 16 }}>
                <span>{B.framingLabel}</span>
              </div>
              <div style={{ font: '300 64px/0.92 var(--font-heading)', color: ink, letterSpacing: '-0.02em' }}>{B.name}</div>
              <div style={{ font: '400 13px/1 var(--font-heading)', color: muted, fontStyle: 'italic', marginTop: 6 }}>{B.tagline} · {B.origin}</div>
              <p style={{ font: '400 14px/1.55 var(--font-body)', color: `${ink}dd`, margin: '20px 0 0', flex: 1 }}>{B.pitch}</p>
              <div style={{ marginTop: 18, paddingTop: 16, borderTop: `0.5px solid ${ink}11`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <div style={{ font: '400 24px/1 var(--font-heading)', color: ink }}>{B.stat.v}</div>
                  <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.14em', color: muted, marginTop: 4, textTransform: 'uppercase' }}>{B.stat.l}</div>
                </div>
                <span style={{ font: '500 11px/1 var(--font-body)', letterSpacing: '0.12em', textTransform: 'uppercase', color: selected ? accent : ink }}>
                  {selected ? 'Selected \u2713' : 'Choose \u2192'}
                </span>
              </div>
            </div>
            <div style={{ position: 'relative', background: `${ink}05`, overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: '20px 20px 20px 0' }}>
                <CabinetSpecimen theme={theme} brand={B.id} door={B.defaults.door} finish={B.defaults.finish} hardware={B.defaults.hardware} softClose />
              </div>
            </div>
          </div>
        </button>
      );
    }

    function CabHero({ theme, brand, setBrand }) {
      const { ink, paper, accent, muted } = theme;
      return (
        <section style={{ position: 'relative', background: paper, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '16px 80px', borderBottom: `0.5px solid ${ink}11`, font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.22em', textTransform: 'uppercase', color: muted, whiteSpace: 'nowrap' }}>
            <span style={{ color: ink }}>Roma · Cabinets</span><span>—</span><span>Two lines, fully stocked</span>
            <span style={{ flex: 1, height: 1, background: `${ink}11` }} />
            <span style={{ color: accent }}>Designed in-house · Installed by our crew</span>
            <span style={{ flex: 1, height: 1, background: `${ink}11` }} />
            <span>Anaheim, CA</span>
          </div>
          <div style={{ padding: '72px 80px 88px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, font: '500 11px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted, marginBottom: 28 }}>
              <span style={{ width: 28, height: 1, background: accent }} /> 01 · Pick a philosophy
            </div>
            <h1 style={{ font: '300 112px/0.92 var(--font-heading)', margin: 0, letterSpacing: '-0.025em', textWrap: 'pretty', color: ink }}>
              Cabinetry, <em style={{ color: accent }}>two ways.</em>
            </h1>
            <p style={{ font: '400 20px/1.55 var(--font-body)', color: `${ink}dd`, margin: '32px 0 0', maxWidth: 760 }}>
              Roma stocks both lines because most kitchens need a little of both. Choose American face-frame craftsmanship, or European frameless precision — both
              <strong style={{ color: ink, fontWeight: 500 }}> sampled, specified, and installed </strong>
              from one Anaheim showroom.
            </p>
            <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
              {Object.values(CAB_BRANDS).map(B => (
                <CabBrandTile key={B.id} theme={theme} B={B} selected={brand === B.id} onPick={() => setBrand(B.id)} />
              ))}
            </div>
          </div>
        </section>
      );
    }

    function CabAnatomyDiagram({ theme, framed, brand }) {
      const { ink, paper, accent, muted } = theme;
      const VB_W = 720, VB_H = 600;
      const CB_X0 = 120, CB_X1 = 600, CB_Y0 = 60, CB_Y1 = 280;
      const WALL = 16, FRAME_DEPTH = 18, FRAME_INWARD = 14, DOOR_THK = 13, DOOR_LEN = 220;
      const MID = (CB_X0 + CB_X1) / 2;
      const frontY = CB_Y1;
      const frameFrontY = frontY + FRAME_DEPTH;
      const leftHinge = framed ? { x: CB_X0 + WALL + FRAME_INWARD, y: frameFrontY } : { x: CB_X0 + WALL, y: frontY };
      const rightInner = framed ? CB_X1 - WALL - FRAME_INWARD : CB_X1 - WALL;
      const openingStart = leftHinge.x, openingEnd = rightInner;
      const usableLabel = framed ? '27\u2033' : '28\u00BD\u2033';
      const doorOpenX = leftHinge.x, doorOpenY = leftHinge.y;
      const doorOpenTipY = doorOpenY + DOOR_LEN;
      const doorClosedTipX = leftHinge.x + DOOR_LEN;

      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, paddingBottom: 12, borderBottom: `0.5px solid ${ink}22` }}>
            <div>
              <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted, marginBottom: 6 }}>Plan view · Section A-A · 1 of 2</div>
              <div style={{ font: '400 32px/1 var(--font-heading)', color: ink, letterSpacing: '-0.01em' }}>{framed ? 'Face-frame' : 'Frameless'}</div>
            </div>
            <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.14em', textTransform: 'uppercase', color: accent }}>{brand.name}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '0 0 18px', gap: 24 }}>
            <div>
              <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Door opening</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ font: '300 64px/0.9 var(--font-heading)', color: ink, letterSpacing: '-0.02em' }}>{usableLabel}</span>
                <span style={{ font: '400 14px/1 var(--font-body)', color: muted, fontStyle: 'italic' }}>{framed ? 'usable, after frame' : 'edge to edge'}</span>
              </div>
            </div>
            <div style={{ font: '500 10px/1.5 ui-monospace, monospace', letterSpacing: '0.14em', textTransform: 'uppercase', color: framed ? muted : accent, textAlign: 'right' }}>
              {framed ? (<React.Fragment><div>Lost to face frame</div><div style={{ color: ink, fontSize: 18, fontFamily: 'var(--font-heading), serif', textTransform: 'none', letterSpacing: '0', marginTop: 6 }}>{'\u2212'}3{'\u2033'} each cabinet</div></React.Fragment>)
                : (<React.Fragment><div>Gained back</div><div style={{ color: ink, fontSize: 18, fontFamily: 'var(--font-heading), serif', textTransform: 'none', letterSpacing: '0', marginTop: 6 }}>+1{'\u00BD\u2033'} each cabinet</div></React.Fragment>)}
            </div>
          </div>
          <div style={{ background: paper, border: `0.5px solid ${ink}22`, padding: '12px 18px 6px' }}>
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
              <defs>
                <pattern id={`anat-hatch-${framed ? 'fr' : 'fl'}`} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="5" stroke={ink} strokeWidth="0.6" strokeOpacity="0.7" />
                </pattern>
                <pattern id={`anat-frame-${framed ? 'fr' : 'fl'}`} patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(-45)">
                  <line x1="0" y1="0" x2="0" y2="4" stroke={ink} strokeWidth="0.5" strokeOpacity="0.55" />
                </pattern>
              </defs>
              {Array.from({ length: 13 }).map((_, i) => <line key={`gv${i}`} x1={120 + i * 40} y1={40} x2={120 + i * 40} y2={540} stroke={ink} strokeOpacity="0.04" strokeWidth="0.5" />)}
              {Array.from({ length: 12 }).map((_, i) => <line key={`gh${i}`} x1={100} y1={60 + i * 40} x2={620} y2={60 + i * 40} stroke={ink} strokeOpacity="0.04" strokeWidth="0.5" />)}
              <g stroke={ink} strokeOpacity="0.4" strokeWidth="0.5" fill={ink} fillOpacity="0.7">
                <line x1={CB_X0} y1={36} x2={CB_X1} y2={36} />
                <line x1={CB_X0} y1={28} x2={CB_X0} y2={44} />
                <line x1={CB_X1} y1={28} x2={CB_X1} y2={44} />
                <rect x={MID - 38} y={26} width="76" height="20" fill={paper} stroke="none" />
                <text x={MID} y={42} fontSize="11" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" textAnchor="middle" stroke="none">30{'\u2033'} EXTERIOR</text>
              </g>
              <rect x={CB_X0 + WALL} y={CB_Y0} width={CB_X1 - CB_X0 - 2 * WALL} height={CB_Y1 - CB_Y0} fill={`${ink}05`} />
              <rect x={CB_X0} y={CB_Y0} width={WALL} height={CB_Y1 - CB_Y0} fill={`url(#anat-hatch-${framed ? 'fr' : 'fl'})`} stroke={ink} strokeWidth="1" />
              <rect x={CB_X1 - WALL} y={CB_Y0} width={WALL} height={CB_Y1 - CB_Y0} fill={`url(#anat-hatch-${framed ? 'fr' : 'fl'})`} stroke={ink} strokeWidth="1" />
              <rect x={CB_X0} y={CB_Y0} width={CB_X1 - CB_X0} height={WALL} fill={`url(#anat-hatch-${framed ? 'fr' : 'fl'})`} stroke={ink} strokeWidth="1" />
              <line x1={CB_X0 + WALL + 2} y1={CB_Y0 + (CB_Y1 - CB_Y0) / 2} x2={CB_X1 - WALL - 2} y2={CB_Y0 + (CB_Y1 - CB_Y0) / 2} stroke={ink} strokeOpacity="0.18" strokeWidth="0.5" strokeDasharray="4,3" />
              <text x={CB_X0 + WALL + 8} y={CB_Y0 + (CB_Y1 - CB_Y0) / 2 - 5} fontSize="8" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.32" stroke="none">ADJ. SHELF</text>
              {framed && (<g>
                <rect x={CB_X0} y={frontY} width={WALL + FRAME_INWARD} height={FRAME_DEPTH + 4} fill={accent} fillOpacity="0.18" />
                <rect x={CB_X1 - WALL - FRAME_INWARD} y={frontY} width={WALL + FRAME_INWARD} height={FRAME_DEPTH + 4} fill={accent} fillOpacity="0.18" />
                <rect x={MID - FRAME_INWARD} y={frontY} width={2 * FRAME_INWARD} height={FRAME_DEPTH + 4} fill={accent} fillOpacity="0.18" />
                <rect x={CB_X0} y={frontY} width={WALL + FRAME_INWARD} height={FRAME_DEPTH} fill={`url(#anat-frame-fr)`} stroke={ink} strokeWidth="1" />
                <rect x={CB_X1 - WALL - FRAME_INWARD} y={frontY} width={WALL + FRAME_INWARD} height={FRAME_DEPTH} fill={`url(#anat-frame-fr)`} stroke={ink} strokeWidth="1" />
                <rect x={MID - FRAME_INWARD} y={frontY} width={2 * FRAME_INWARD} height={FRAME_DEPTH} fill={`url(#anat-frame-fr)`} stroke={ink} strokeWidth="1" />
                <line x1={CB_X0 + WALL + FRAME_INWARD} y1={frontY + 2} x2={MID - FRAME_INWARD} y2={frontY + 2} stroke={ink} strokeOpacity="0.5" strokeWidth="0.7" />
                <line x1={CB_X0 + WALL + FRAME_INWARD} y1={frameFrontY - 2} x2={MID - FRAME_INWARD} y2={frameFrontY - 2} stroke={ink} strokeOpacity="0.5" strokeWidth="0.7" />
                <line x1={MID + FRAME_INWARD} y1={frontY + 2} x2={CB_X1 - WALL - FRAME_INWARD} y2={frontY + 2} stroke={ink} strokeOpacity="0.5" strokeWidth="0.7" />
                <line x1={MID + FRAME_INWARD} y1={frameFrontY - 2} x2={CB_X1 - WALL - FRAME_INWARD} y2={frameFrontY - 2} stroke={ink} strokeOpacity="0.5" strokeWidth="0.7" />
                <g stroke={accent} strokeWidth="1" fill={accent}>
                  <line x1={CB_X0 + WALL - 4} y1={frontY + FRAME_DEPTH + 14} x2={CB_X0 + WALL + FRAME_INWARD + 2} y2={frontY + FRAME_DEPTH + 14} />
                  <polygon points={`${CB_X0 + WALL + FRAME_INWARD + 2},${frontY + FRAME_DEPTH + 14} ${CB_X0 + WALL + FRAME_INWARD - 6},${frontY + FRAME_DEPTH + 10} ${CB_X0 + WALL + FRAME_INWARD - 6},${frontY + FRAME_DEPTH + 18}`} />
                </g>
              </g>)}
              <rect x={framed ? MID + FRAME_INWARD + 2 : MID + 2} y={framed ? frameFrontY : frontY} width={framed ? CB_X1 - WALL - FRAME_INWARD - MID - FRAME_INWARD - 2 : CB_X1 - WALL - MID - 2} height={DOOR_THK} fill={ink} fillOpacity="0.86" stroke={ink} strokeWidth="0.6" />
              <path d={`M ${doorClosedTipX} ${doorOpenY} A ${DOOR_LEN} ${DOOR_LEN} 0 0 1 ${doorOpenX} ${doorOpenY + DOOR_LEN}`} fill="none" stroke={accent} strokeWidth="0.8" strokeDasharray="4,4" strokeOpacity="0.5" />
              <rect x={doorOpenX} y={doorOpenY} width={DOOR_LEN} height={DOOR_THK} fill="none" stroke={ink} strokeWidth="0.5" strokeDasharray="3,3" strokeOpacity="0.3" />
              <rect x={doorOpenX} y={doorOpenY} width={DOOR_THK} height={DOOR_LEN} fill={ink} fillOpacity="0.86" stroke={ink} strokeWidth="0.6" />
              <line x1={doorOpenX + DOOR_THK / 2} y1={doorOpenY + 6} x2={doorOpenX + DOOR_THK / 2} y2={doorOpenY + DOOR_LEN - 6} stroke={paper} strokeOpacity="0.15" strokeWidth="0.5" />
              {framed ? (<g>
                <rect x={doorOpenX - 6} y={doorOpenY + 12} width={6} height={14} fill={accent} stroke={ink} strokeWidth="0.5" />
                <rect x={doorOpenX - 6} y={doorOpenY + DOOR_LEN - 26} width={6} height={14} fill={accent} stroke={ink} strokeWidth="0.5" />
                <circle cx={doorOpenX} cy={doorOpenY + 19} r="2" fill={ink} />
                <circle cx={doorOpenX} cy={doorOpenY + DOOR_LEN - 19} r="2" fill={ink} />
                <rect x={CB_X1 - WALL - FRAME_INWARD - 4} y={frameFrontY + DOOR_THK / 2 - 7} width={8} height={14} fill={accent} stroke={ink} strokeWidth="0.5" />
              </g>) : (<g>
                {[CB_Y0 + 32, CB_Y1 - 56].map((cy, i) => (<g key={`lh${i}`}>
                  <rect x={CB_X0 + WALL} y={cy - 4} width={22} height={28} fill={paper} stroke={ink} strokeWidth="0.7" />
                  <line x1={CB_X0 + WALL + 4} y1={cy} x2={CB_X0 + WALL + 18} y2={cy} stroke={ink} strokeOpacity="0.35" strokeWidth="0.5" />
                  <line x1={CB_X0 + WALL + 4} y1={cy + 20} x2={CB_X0 + WALL + 18} y2={cy + 20} stroke={ink} strokeOpacity="0.35" strokeWidth="0.5" />
                  <path d={`M ${CB_X0 + WALL + 22} ${cy + 10} L ${CB_X0 + WALL + 32} ${cy + 10} L ${doorOpenX + DOOR_THK / 2} ${doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18)}`} fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx={doorOpenX + DOOR_THK / 2} cy={doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18)} r="5" fill={paper} stroke={accent} strokeWidth="1.2" />
                  <circle cx={doorOpenX + DOOR_THK / 2} cy={doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18)} r="2" fill={accent} />
                  <circle cx={CB_X0 + WALL + 7} cy={cy + 6} r="1.4" fill={ink} fillOpacity="0.5" />
                  <circle cx={CB_X0 + WALL + 7} cy={cy + 18} r="1.4" fill={ink} fillOpacity="0.5" />
                </g>))}
                {[CB_Y0 + 32, CB_Y1 - 56].map((cy, i) => (<g key={`rh${i}`}>
                  <rect x={CB_X1 - WALL - 22} y={cy - 4} width={22} height={28} fill={paper} stroke={ink} strokeWidth="0.7" />
                  <line x1={CB_X1 - WALL - 18} y1={cy} x2={CB_X1 - WALL - 4} y2={cy} stroke={ink} strokeOpacity="0.35" strokeWidth="0.5" />
                  <line x1={CB_X1 - WALL - 18} y1={cy + 20} x2={CB_X1 - WALL - 4} y2={cy + 20} stroke={ink} strokeOpacity="0.35" strokeWidth="0.5" />
                  <circle cx={CB_X1 - WALL - 7} cy={cy + 6} r="1.4" fill={ink} fillOpacity="0.5" />
                  <circle cx={CB_X1 - WALL - 7} cy={cy + 18} r="1.4" fill={ink} fillOpacity="0.5" />
                </g>))}
              </g>)}
              {framed ? (<g>
                <line x1={CB_X0 + WALL + FRAME_INWARD / 2} y1={frontY + FRAME_DEPTH / 2} x2={CB_X0 + 4} y2={frontY + 60} stroke={ink} strokeOpacity="0.55" strokeWidth="0.6" />
                <circle cx={CB_X0 + WALL + FRAME_INWARD / 2} cy={frontY + FRAME_DEPTH / 2} r="2" fill={ink} />
                <text x={CB_X0 + 4} y={frontY + 76} fontSize="12" fontFamily="ui-monospace, monospace" letterSpacing="0.16em" fill={ink} fillOpacity="0.8" textAnchor="start" stroke="none">1{'\u00BD\u2033'} FRAME</text>
                <text x={CB_X0 + 4} y={frontY + 92} fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="start" stroke="none">maple stile</text>
                <line x1={doorOpenX - 3} y1={doorOpenY + 19} x2={CB_X1 - 4} y2={frontY + 70} stroke={ink} strokeOpacity="0.55" strokeWidth="0.6" />
                <circle cx={doorOpenX - 3} cy={doorOpenY + 19} r="2" fill={ink} />
                <text x={CB_X1 - 4} y={frontY + 86} fontSize="12" fontFamily="ui-monospace, monospace" letterSpacing="0.16em" fill={ink} fillOpacity="0.8" textAnchor="end" stroke="none">BUTT HINGE</text>
                <text x={CB_X1 - 4} y={frontY + 102} fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="end" stroke="none">mortised</text>
              </g>) : (<g>
                <line x1={CB_X0 + WALL + 11} y1={CB_Y0 + 42} x2={CB_X0 + 4} y2={CB_Y0 + 8} stroke={ink} strokeOpacity="0.55" strokeWidth="0.6" />
                <circle cx={CB_X0 + WALL + 11} cy={CB_Y0 + 42} r="2" fill={ink} />
                <text x={CB_X0 + 4} y={CB_Y0 - 6} fontSize="12" fontFamily="ui-monospace, monospace" letterSpacing="0.16em" fill={ink} fillOpacity="0.8" textAnchor="start" stroke="none">35mm CUP</text>
                <text x={CB_X0 + 4} y={CB_Y0 + 10} fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="start" stroke="none">3-way adj.</text>
                <line x1={doorOpenX + DOOR_THK / 2} y1={doorOpenY + DOOR_LEN / 2} x2={CB_X1 - 4} y2={frontY + 90} stroke={ink} strokeOpacity="0.55" strokeWidth="0.6" />
                <circle cx={doorOpenX + DOOR_THK / 2} cy={doorOpenY + DOOR_LEN / 2} r="2" fill={ink} />
                <text x={CB_X1 - 4} y={frontY + 106} fontSize="12" fontFamily="ui-monospace, monospace" letterSpacing="0.16em" fill={ink} fillOpacity="0.8" textAnchor="end" stroke="none">FULL OVERLAY</text>
                <text x={CB_X1 - 4} y={frontY + 122} fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="end" stroke="none">19mm slab</text>
              </g>)}
              <text x={CB_X0 + WALL / 2} y={CB_Y0 + (CB_Y1 - CB_Y0) / 2 + 3} fontSize="8" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="middle" stroke="none" transform={`rotate(-90, ${CB_X0 + WALL / 2}, ${CB_Y0 + (CB_Y1 - CB_Y0) / 2})`}>{'\u00BE\u2033'} PLY</text>
              <text x={CB_X1 - WALL / 2} y={CB_Y0 + (CB_Y1 - CB_Y0) / 2 + 3} fontSize="8" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.55" textAnchor="middle" stroke="none" transform={`rotate(-90, ${CB_X1 - WALL / 2}, ${CB_Y0 + (CB_Y1 - CB_Y0) / 2})`}>{'\u00BE\u2033'} PLY</text>
              <text x={doorOpenX + DOOR_THK + 6} y={doorOpenY + DOOR_LEN + 14} fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.5" stroke="none">DOOR · 90° OPEN</text>
              <text x={CB_X1 - 6} y={(framed ? frameFrontY : frontY) - 4} fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.14em" fill={ink} fillOpacity="0.5" textAnchor="end" stroke="none">DOOR · CLOSED</text>
              <g stroke={accent} strokeWidth="1.4" fill={accent}>
                <line x1={openingStart} y1={500} x2={openingEnd} y2={500} />
                <polygon points={`${openingStart},${500} ${openingStart + 12},${493} ${openingStart + 12},${507}`} />
                <polygon points={`${openingEnd},${500} ${openingEnd - 12},${493} ${openingEnd - 12},${507}`} />
                <line x1={openingStart} y1={488} x2={openingStart} y2={512} />
                <line x1={openingEnd} y1={488} x2={openingEnd} y2={512} />
              </g>
              <g>
                <rect x={MID - 80} y={488} width="160" height="24" fill={paper} stroke="none" />
                <text x={MID} y={508} textAnchor="middle" fontSize="22" fontWeight="400" fontFamily="var(--font-heading), serif" fill={ink} stroke="none">{usableLabel}</text>
              </g>
              <text x={MID} y={530} textAnchor="middle" fontSize="11" fontFamily="ui-monospace, monospace" letterSpacing="0.18em" fill={accent} stroke="none">{framed ? '\u2014 30\u2033 EXT \u2212 1\u00BD\u2033 WALLS \u2212 1\u00BD\u2033 FRAME \u2014' : '\u2014 30\u2033 EXT \u2212 1\u00BD\u2033 WALLS \u2014'}</text>
              <g fill={ink} fillOpacity="0.5" fontFamily="ui-monospace, monospace" fontSize="9" letterSpacing="0.16em">
                <line x1={CB_X0} y1={552} x2={CB_X1} y2={552} stroke={ink} strokeOpacity="0.15" strokeWidth="0.5" />
                <text x={CB_X0} y={570} stroke="none">SCALE 1:8 · SECTION A-A @ 17{'\u2033'} AFF</text>
                <text x={CB_X1} y={570} textAnchor="end" stroke="none">B30 · 30{'\u2033'} {'\u00D7'} 24{'\u2033'} {'\u00D7'} 34{'\u00BD\u2033'} H</text>
              </g>
            </svg>
          </div>
          <div style={{ marginTop: 22, display: 'grid', gap: 10 }}>
            {(framed ? [
              'Face frame keeps door alignment perfect for decades',
              'Traditional door styles (shaker, beaded, raised) need the frame to read correctly',
              'Field-repairable \u2014 broken butt hinge swaps in 10 min, no special tools',
              'Slight reveal between doors hides minor wood movement',
            ] : [
              'Zero face-frame intrusion · ~1\u00BD\u2033 more usable opening per cabinet',
              'Doors flush with one another \u2014 no visible gaps, no shadow lines',
              'Concealed European cup hinge adjusts in three planes after install',
              'Required for handleless, integrated-channel, and push-to-open designs',
            ]).map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, marginTop: 7, flexShrink: 0 }} />
                <span style={{ font: '400 14px/1.45 var(--font-body)', color: `${ink}dd` }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    function CabAnatomy({ theme }) {
      const { ink, paper, accent, muted } = theme;
      return (
        <section style={{ padding: '120px 80px', borderTop: `0.5px solid ${ink}11`, background: paper }}>
          <CabSectionHead theme={theme} num="02" eyebrow="The Bones" headline={<>Framed, <em style={{ color: accent }}>or frameless.</em></>} sub="The single decision that drives most of the others. Same finish, two very different ways of getting inside the box." />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56, alignItems: 'start' }}>
            <CabAnatomyDiagram theme={theme} framed brand={CAB_BRANDS.waypoint} />
            <CabAnatomyDiagram theme={theme} brand={CAB_BRANDS.europa} />
          </div>
          <div style={{ marginTop: 56, padding: '36px 40px', background: ink, color: paper, position: 'relative', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 40, alignItems: 'center' }}>
            <div style={{ position: 'absolute', top: -80, right: -40, width: 240, height: 240, borderRadius: '50%', background: `radial-gradient(circle at 30% 30%, ${accent}33, transparent 70%)` }} />
            <div style={{ position: 'relative' }}>
              <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.22em', textTransform: 'uppercase', color: accent, marginBottom: 10 }}>The delta</div>
              <div style={{ font: '300 36px/1.05 var(--font-heading)', color: paper, letterSpacing: '-0.01em', textWrap: 'pretty' }}>
                Over a 24-foot kitchen run, frameless gives you back <em style={{ color: accent, fontStyle: 'italic', fontWeight: 400 }}> 14 extra inches</em> of usable interior.
              </div>
            </div>
            {[{ v: '1\u00BD\u2033', l: 'Per cabinet' }, { v: '14\u2033', l: 'Over 24-ft run' }, { v: '~5\u201310%', l: 'More interior' }].map((s, i) => (
              <div key={i} style={{ position: 'relative', paddingLeft: 24, borderLeft: `0.5px solid ${paper}22` }}>
                <div style={{ font: '300 42px/1 var(--font-heading)', color: paper }}>{s.v}</div>
                <div style={{ font: '500 10px/1.3 ui-monospace, monospace', letterSpacing: '0.16em', textTransform: 'uppercase', color: `${paper}88`, marginTop: 8 }}>{s.l}</div>
              </div>
            ))}
          </div>
        </section>
      );
    }

    function CabConfigGroup({ theme, label, children }) {
      const { ink, muted } = theme;
      return (
        <div>
          <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted, marginBottom: 12, paddingBottom: 8, borderBottom: `0.5px solid ${ink}11` }}>{label}</div>
          {children}
        </div>
      );
    }

    function CabSegRow({ theme, value, onChange, options }) {
      const { ink, paper, accent, muted } = theme;
      return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${options.length}, 1fr)`, gap: 0, border: `0.5px solid ${ink}22` }}>
          {options.map((o, i) => {
            const active = value === o.id;
            return (
              <button key={o.id} onClick={() => onChange(o.id)} style={{
                padding: '12px 14px', cursor: 'pointer', background: active ? ink : 'transparent', color: active ? paper : ink,
                border: 'none', borderLeft: i === 0 ? 'none' : `0.5px solid ${ink}22`,
                font: '500 11px/1 var(--font-body)', letterSpacing: '0.06em', transition: 'background .15s, color .15s',
              }}>{o.label}</button>
            );
          })}
        </div>
      );
    }

    function CabMiniDoor({ theme, d, brand, finish }) {
      const B = CAB_BRANDS[brand];
      const F = B.finishes.find(f => f.id === finish) || B.finishes[0];
      return (
        <svg viewBox="0 0 60 64" style={{ width: '100%', height: '100%', display: 'block' }}>
          <defs>
            {F.wood && (<pattern id={`mini-wood-${brand}-${F.id}`} patternUnits="userSpaceOnUse" width="60" height="10" patternTransform="rotate(90)">
              <rect width="60" height="10" fill={F.tone.a} />
              <rect x="0" y="3" width="60" height="0.6" fill={F.tone.c} opacity="0.45" />
              <rect x="0" y="7" width="60" height="0.5" fill={F.tone.c} opacity="0.3" />
              <rect x="0" y="0" width="0.5" height="10" fill={F.tone.c} opacity="0.35" />
              <rect x="29" y="0" width="0.5" height="10" fill={F.tone.c} opacity="0.28" />
            </pattern>)}
            <linearGradient id="mini-gloss" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.5)" />
              <stop offset="50%" stopColor="rgba(255,255,255,0)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.2)" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="60" height="64" fill={F.wood ? `url(#mini-wood-${brand}-${F.id})` : F.fill} />
          {F.family === 'gloss' && <rect x="0" y="0" width="60" height="64" fill="url(#mini-gloss)" />}
          {d.profile === 'shaker' && <rect x="8" y="8" width="44" height="48" fill="rgba(0,0,0,0.06)" stroke="rgba(0,0,0,0.18)" strokeWidth="0.4" />}
          {d.profile === 'recessed' && <rect x="6" y="6" width="48" height="52" fill="rgba(0,0,0,0.06)" stroke="rgba(0,0,0,0.18)" strokeWidth="0.4" />}
          {d.profile === 'raised' && (() => { const ix0=8,iy0=8,ix1=52,iy1=56,ch=4; return (<g><polygon points={`${ix0+ch},${iy0+ch} ${ix1-ch},${iy0+ch} ${ix1-ch},${iy1-ch} ${ix0+ch},${iy1-ch}`} fill="rgba(255,255,255,0.2)" /><polygon points={`${ix0},${iy0} ${ix1},${iy0} ${ix1-ch},${iy0+ch} ${ix0+ch},${iy0+ch}`} fill="rgba(255,255,255,0.18)" /><polygon points={`${ix0},${iy1} ${ix1},${iy1} ${ix1-ch},${iy1-ch} ${ix0+ch},${iy1-ch}`} fill="rgba(0,0,0,0.16)" /></g>); })()}
          {d.profile === 'beaded' && (<g><rect x="6" y="6" width="48" height="52" fill="rgba(0,0,0,0.04)" /><rect x="9" y="9" width="42" height="46" fill="none" stroke="rgba(0,0,0,0.22)" strokeWidth="0.4" /></g>)}
          {d.profile === 'arched' && <path d="M 8 56 L 8 18 Q 8 8 30 8 Q 52 8 52 18 L 52 56 Z" fill="rgba(0,0,0,0.05)" stroke="rgba(0,0,0,0.2)" strokeWidth="0.4" />}
          {d.profile === 'mullion' && (<g stroke="rgba(0,0,0,0.28)" strokeWidth="0.4" fill="rgba(255,255,255,0.1)"><rect x="8" y="8" width="44" height="48" /><line x1="8" y1="32" x2="52" y2="32" /><line x1="30" y1="8" x2="30" y2="56" /></g>)}
          {d.profile === 'channel' && <rect x="0" y="0" width="60" height="6" fill="rgba(0,0,0,0.4)" />}
          {d.profile === 'slim' && <rect x="4" y="4" width="52" height="56" fill="none" stroke="rgba(0,0,0,0.2)" strokeWidth="0.3" />}
          {d.profile === 'reeded' && (<g stroke="rgba(0,0,0,0.22)" strokeWidth="0.5">{Array.from({length:9}).map((_,i)=><line key={i} x1={4+i*6.5} y1="0" x2={4+i*6.5} y2="64" />)}</g>)}
          {d.profile === 'glass' && (<g><rect x="6" y="6" width="48" height="52" fill="rgba(255,255,255,0.25)" stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" /><line x1="30" y1="6" x2="30" y2="58" stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" /><line x1="6" y1="32" x2="54" y2="32" stroke="rgba(0,0,0,0.25)" strokeWidth="0.5" /><line x1="10" y1="10" x2="22" y2="22" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" /></g>)}
        </svg>
      );
    }

    function CabDoorChoice({ theme, d, brand, finish, active, onPick }) {
      const { ink, paper, accent, muted } = theme;
      return (
        <button onClick={onPick} style={{ position: 'relative', cursor: 'pointer', padding: 0, background: paper, border: `0.5px solid ${active ? accent : ink + '22'}`, boxShadow: active ? `0 0 0 1px ${accent}` : 'none', display: 'grid', gridTemplateColumns: '60px 1fr', alignItems: 'stretch', textAlign: 'left', transition: 'border-color .15s, box-shadow .15s' }}>
          <div style={{ width: 60, height: 64, overflow: 'hidden' }}><CabMiniDoor theme={theme} d={d} brand={brand} finish={finish} /></div>
          <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ font: '400 14px/1.1 var(--font-heading)', color: ink, letterSpacing: '-0.005em' }}>{d.name}</div>
            <div style={{ font: '500 9px/1 ui-monospace, monospace', letterSpacing: '0.14em', textTransform: 'uppercase', color: muted, marginTop: 3 }}>{d.profile}{d.sheen ? ` · ${d.sheen}` : ''}</div>
          </div>
        </button>
      );
    }

    function CabFinishSwatch({ theme, f, active, onPick }) {
      const { ink, paper, accent } = theme;
      const dark = (() => { const hex = (f.fill || '#888').replace('#', ''); const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16); return (r * 0.299 + g * 0.587 + b * 0.114) < 130; })();
      const overlayText = dark ? paper : ink;
      return (
        <button onClick={onPick} style={{ position: 'relative', cursor: 'pointer', padding: 0, height: 78, border: 'none', background: 'transparent' }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', boxShadow: active ? `0 0 0 2px ${accent}, 0 8px 18px ${ink}33` : `0 0 0 0.5px ${ink}22`, transition: 'box-shadow .15s' }}>
            {f.wood ? <div style={{ position: 'absolute', inset: 0, ...materialFace('wood', f.tone) }} /> : <div style={{ position: 'absolute', inset: 0, background: f.fill }} />}
            {f.family === 'gloss' && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.5) 0%, transparent 40%, transparent 60%, rgba(0,0,0,0.22) 100%)' }} />}
            {f.family === 'textured' && <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(rgba(0,0,0,0.18) 1px, transparent 1.4px)', backgroundSize: '5px 5px', mixBlendMode: 'overlay' }} />}
          </div>
          <div style={{ position: 'absolute', left: 6, top: 6, right: 6, font: '500 8px/1.1 ui-monospace, monospace', letterSpacing: '0.1em', color: overlayText, textTransform: 'uppercase', opacity: 0.85, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.name}>{f.name}</div>
          {active && <div style={{ position: 'absolute', right: 6, bottom: 6, width: 18, height: 18, borderRadius: '50%', background: accent, color: paper, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 11px/1 var(--font-body)' }}>{'\u2713'}</div>}
        </button>
      );
    }

    function CabConfigurator({ theme, brand, setBrand }) {
      const { ink, paper, accent, muted } = theme;
      const B = CAB_BRANDS[brand];
      const [door, setDoor] = useState(B.defaults.door);
      const [finish, setFinish] = useState(B.defaults.finish);
      const [hardware, setHardware] = useState(B.defaults.hardware);
      const [softClose, setSoftClose] = useState(true);
      const [inserts, setInserts] = useState({ trash: true, spice: false, lazy: false, divider: true });
      useEffect(() => {
        const validDoor = B.doors.some(d => d.id === door);
        const validFinish = B.finishes.some(f => f.id === finish);
        const validHw = B.hardware.some(h => h.id === hardware);
        if (!validDoor) setDoor(B.defaults.door);
        if (!validFinish) setFinish(B.defaults.finish);
        if (!validHw) setHardware(B.defaults.hardware);
      }, [brand]);
      const F = B.finishes.find(f => f.id === finish) || B.finishes[0];
      const D = B.doors.find(d => d.id === door) || B.doors[0];
      const H = B.hardware.find(h => h.id === hardware) || B.hardware[0];
      return (
        <section style={{ padding: '120px 80px', background: `${ink}05`, borderTop: `0.5px solid ${ink}11` }}>
          <CabSectionHead theme={theme} num="03" eyebrow="Build a sample" headline={<>Configure a base unit. <em style={{ color: accent }}>See it live.</em></>} sub="Every choice updates the specimen. Brand, door, finish, hardware, and inserts — the same set of decisions you'll make in the showroom, surfaced up front." />
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 56, alignItems: 'start' }}>
            <div>
              <div style={{ background: paper, padding: 24, border: `0.5px solid ${ink}11`, position: 'relative' }}>
                <CabinetSpecimen theme={theme} brand={brand} door={door} finish={finish} hardware={hardware} softClose={softClose} big />
              </div>
              <div style={{ marginTop: 16, padding: '18px 20px', background: paper, border: `0.5px solid ${ink}11`, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0 }}>
                {[
                  { l: 'Unit', v: 'B36 \u2014 36" Base', mono: true },
                  { l: 'Door', v: D.name },
                  { l: 'Finish', v: F.name },
                  { l: 'Hardware', v: H.name },
                  { l: 'SKU', v: `${B.name.slice(0,2).toUpperCase()}-${door.slice(0,2).toUpperCase()}-${finish.slice(0,2).toUpperCase()}-${hardware.slice(0,2).toUpperCase()}`.toUpperCase(), mono: true },
                ].map((it, i) => (
                  <div key={i} style={{ paddingLeft: i === 0 ? 0 : 18, borderLeft: i === 0 ? 'none' : `0.5px solid ${ink}11` }}>
                    <div style={{ font: '500 9px/1 ui-monospace, monospace', letterSpacing: '0.18em', textTransform: 'uppercase', color: muted, marginBottom: 6 }}>{it.l}</div>
                    <div style={{ font: it.mono ? '500 12px/1.2 ui-monospace, monospace' : '400 15px/1.2 var(--font-heading)', color: ink, letterSpacing: it.mono ? '0.08em' : '-0.005em' }}>{it.v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 32 }}>
              <CabConfigGroup theme={theme} label="Brand">
                <CabSegRow theme={theme} value={brand} onChange={setBrand} options={[{ id: 'waypoint', label: 'Waypoint' }, { id: 'europa', label: 'Europa' }]} />
              </CabConfigGroup>
              <CabConfigGroup theme={theme} label={`Door style · ${B.doors.length}`}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {B.doors.map(d => <CabDoorChoice key={d.id} theme={theme} d={d} brand={brand} finish={finish} active={door === d.id} onPick={() => setDoor(d.id)} />)}
                </div>
              </CabConfigGroup>
              <CabConfigGroup theme={theme} label={`Finish · ${B.finishes.length} colors`}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
                  {B.finishes.map(f => <CabFinishSwatch key={f.id} theme={theme} f={f} active={finish === f.id} onPick={() => setFinish(f.id)} />)}
                </div>
              </CabConfigGroup>
              <CabConfigGroup theme={theme} label="Hardware">
                <CabSegRow theme={theme} value={hardware} onChange={setHardware} options={B.hardware.map(h => ({ id: h.id, label: h.name }))} />
              </CabConfigGroup>
              <CabConfigGroup theme={theme} label="Performance">
                <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '12px 14px', border: `0.5px solid ${ink}22`, background: softClose ? `${accent}11` : 'transparent' }}>
                  <span style={{ width: 36, height: 20, borderRadius: 10, background: softClose ? accent : `${ink}22`, position: 'relative', transition: 'background .2s', flexShrink: 0 }}>
                    <span style={{ position: 'absolute', top: 2, left: softClose ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: paper, transition: 'left .2s' }} />
                  </span>
                  <span style={{ flex: 1, font: '400 14px/1.3 var(--font-body)', color: ink }}>Soft-close hinges & drawer slides</span>
                  <input type="checkbox" checked={softClose} onChange={(e) => setSoftClose(e.target.checked)} style={{ display: 'none' }} />
                </label>
              </CabConfigGroup>
              <CabConfigGroup theme={theme} label="Add interior fittings">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { id: 'trash', l: 'Pull-out trash bin', d: 'Twin 35-qt bins, blumotion close.' },
                    { id: 'spice', l: 'Spice rack pull-out', d: '4" wide vertical filler unit.' },
                    { id: 'lazy', l: 'Lazy susan corner', d: 'Two-tier 360\u00B0 rotating shelves.' },
                    { id: 'divider', l: 'Drawer organizer', d: 'Walnut grid, custom-cut to fit.' },
                  ].map(it => (
                    <button key={it.id} onClick={() => setInserts(p => ({ ...p, [it.id]: !p[it.id] }))} style={{ textAlign: 'left', cursor: 'pointer', padding: '12px 14px', border: `0.5px solid ${ink}22`, background: inserts[it.id] ? `${accent}11` : 'transparent', borderColor: inserts[it.id] ? accent : `${ink}22` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ width: 14, height: 14, border: `1.5px solid ${inserts[it.id] ? accent : ink + '55'}`, background: inserts[it.id] ? accent : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          {inserts[it.id] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={theme.paper} strokeWidth="3"><path d="M5 12l5 5 9-11" /></svg>}
                        </span>
                        <span style={{ font: '500 12px/1.2 var(--font-body)', color: ink }}>{it.l}</span>
                      </div>
                      <div style={{ font: '400 11px/1.4 var(--font-body)', color: muted, paddingLeft: 22 }}>{it.d}</div>
                    </button>
                  ))}
                </div>
              </CabConfigGroup>
              <div style={{ marginTop: 4, padding: '20px 22px', background: ink, color: paper, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.18em', textTransform: 'uppercase', color: accent, marginBottom: 6 }}>Estimated · {B.lead}</div>
                  <div style={{ font: '300 28px/1 var(--font-heading)', color: paper, whiteSpace: 'nowrap' }}>from {B.startingAt}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                  <button style={{ ...cabBtn(accent, paper, 'primary', theme), padding: '11px 16px', fontSize: 11 }}>Order sample</button>
                  <button style={{ ...cabBtn(paper, ink, 'primary', theme), background: 'transparent', color: paper, border: `0.5px solid ${paper}55`, padding: '11px 16px', fontSize: 11 }}>Wishlist</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      );
    }

    function CabFeatureIcon({ theme, kind }) {
      const { ink, accent } = theme;
      const W = 240, H = 180, cab = ink, mover = accent;
      switch (kind) {
        case 'trash': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="20" width="200" height="140" fill="none" stroke={cab} strokeWidth="2" /><line x1="20" y1="40" x2="220" y2="40" stroke={cab} strokeWidth="1" strokeOpacity="0.3" /><rect x="40" y="60" width="60" height="80" fill="none" stroke={mover} strokeWidth="1.5" /><line x1="40" y1="70" x2="100" y2="70" stroke={mover} strokeWidth="1.2" /><rect x="120" y="60" width="60" height="80" fill="none" stroke={mover} strokeWidth="1.5" /><line x1="120" y1="70" x2="180" y2="70" stroke={mover} strokeWidth="1.2" /></svg>);
        case 'lazy': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><path d="M 20 30 L 20 160 L 220 160 L 220 30 L 130 30 L 100 30 Z" fill="none" stroke={cab} strokeWidth="2" /><circle cx="115" cy="100" r="62" fill="none" stroke={mover} strokeWidth="1.5" strokeDasharray="3,3" /><circle cx="115" cy="100" r="40" fill="none" stroke={mover} strokeWidth="1.5" /><line x1="115" y1="100" x2="175" y2="60" stroke={mover} strokeWidth="1.2" /><line x1="115" y1="100" x2="60" y2="80" stroke={mover} strokeWidth="1.2" /></svg>);
        case 'spice': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="60" y="20" width="120" height="140" fill="none" stroke={cab} strokeWidth="2" /><rect x="100" y="30" width="40" height="120" fill="none" stroke={mover} strokeWidth="1.5" />{[50,70,90,110,130].map(y=>(<g key={y}><line x1="100" y1={y} x2="140" y2={y} stroke={mover} strokeWidth="1" /><rect x="104" y={y+3} width="8" height="12" fill={mover} fillOpacity="0.5" /><rect x="116" y={y+3} width="8" height="12" fill={mover} fillOpacity="0.5" /><rect x="128" y={y+3} width="8" height="12" fill={mover} fillOpacity="0.5" /></g>))}</svg>);
        case 'rollout': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="20" width="200" height="140" fill="none" stroke={cab} strokeWidth="2" /><line x1="20" y1="60" x2="220" y2="60" stroke={cab} strokeWidth="1" strokeOpacity="0.3" /><line x1="20" y1="110" x2="220" y2="110" stroke={cab} strokeWidth="1" strokeOpacity="0.3" /><rect x="70" y="68" width="110" height="34" fill="none" stroke={mover} strokeWidth="1.5" /><rect x="40" y="118" width="110" height="34" fill="none" stroke={mover} strokeWidth="1.5" /></svg>);
        case 'plate': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="20" width="200" height="140" fill="none" stroke={cab} strokeWidth="2" />{[40,70,100,130,160,190].map(x=><line key={x} x1={x} y1="35" x2={x} y2="145" stroke={mover} strokeWidth="1.2" />)}{[55,85,115,145,175].map(x=><circle key={x} cx={x} cy="90" r="14" fill="none" stroke={mover} strokeWidth="1" strokeOpacity="0.7" />)}</svg>);
        case 'divider': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="30" width="200" height="120" fill="none" stroke={cab} strokeWidth="2" /><line x1="80" y1="30" x2="80" y2="150" stroke={mover} strokeWidth="1.5" /><line x1="140" y1="30" x2="140" y2="150" stroke={mover} strokeWidth="1.5" /><line x1="20" y1="90" x2="80" y2="90" stroke={mover} strokeWidth="1.5" /><line x1="140" y1="70" x2="220" y2="70" stroke={mover} strokeWidth="1.5" /><line x1="140" y1="110" x2="220" y2="110" stroke={mover} strokeWidth="1.5" /></svg>);
        case 'softclose': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="40" width="100" height="100" fill="none" stroke={cab} strokeWidth="2" /><line x1="120" y1="40" x2="120" y2="140" stroke={cab} strokeWidth="2" /><g transform="translate(120 90)"><path d="M 0 -28 A 38 38 0 0 1 38 0 A 38 38 0 0 1 0 28" stroke={mover} strokeWidth="2" fill="none" strokeDasharray="4,4" /><line x1="0" y1="0" x2="0" y2="-28" stroke={mover} strokeWidth="2" /><line x1="0" y1="0" x2="28" y2="0" stroke={mover} strokeWidth="2" /><circle cx="0" cy="0" r="3" fill={mover} /></g><rect x="160" y="70" width="40" height="40" fill={mover} fillOpacity="0.18" stroke={mover} strokeWidth="1" /><text x="180" y="96" textAnchor="middle" fontSize="14" fontFamily="var(--font-heading), serif" fill={ink}>S/C</text></svg>);
        case 'tipout': return (<svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}}><rect x="20" y="20" width="200" height="140" fill="none" stroke={cab} strokeWidth="2" /><line x1="20" y1="60" x2="220" y2="60" stroke={cab} strokeWidth="1" strokeOpacity="0.3" /><g transform="translate(120 60)"><rect x="-80" y="-20" width="160" height="22" fill="none" stroke={mover} strokeWidth="1.5" transform="rotate(-22)" /></g><rect x="60" y="78" width="120" height="14" fill={mover} fillOpacity="0.5" stroke={mover} strokeWidth="1" /></svg>);
        default: return null;
      }
    }

    function CabFeatures({ theme }) {
      const { ink, paper, accent, muted } = theme;
      const features = [
        { id: 'trash', name: 'Pull-out trash', blurb: 'Twin 35-qt bins on full-extension slides.', icon: 'trash' },
        { id: 'lazy', name: 'Lazy-susan corner', blurb: 'Two-tier 360\u00B0 rotating shelves.', icon: 'lazy' },
        { id: 'spice', name: 'Spice pull-out', blurb: '4\u2033 filler unit, four tiered shelves.', icon: 'spice' },
        { id: 'rollout', name: 'Roll-out tray', blurb: 'Convert any door cabinet into a deep drawer.', icon: 'rollout' },
        { id: 'plate', name: 'Plate rack divider', blurb: 'Vertical slots for plates and cookware lids.', icon: 'plate' },
        { id: 'divider', name: 'Drawer organizer', blurb: 'Walnut grid, custom-cut to your drawer width.', icon: 'divider' },
        { id: 'softclose', name: 'Soft-close hinges', blurb: 'Cushioned closing, every door, every drawer.', icon: 'softclose' },
        { id: 'tipout', name: 'Sink-front tip-out', blurb: 'Sponge tray hidden behind a false-front panel.', icon: 'tipout' },
      ];
      return (
        <section style={{ padding: '120px 80px', background: paper, borderTop: `0.5px solid ${ink}11` }}>
          <CabSectionHead theme={theme} num="04" eyebrow="Inside the box" headline={<>Storage that <em style={{ color: accent }}>actually stores.</em></>} sub={"Every Roma cabinet is sized to a 16\u2033 deep insert. Mix-and-match these on the configurator above."} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
            {features.map((f, i) => (
              <div key={f.id} style={{ position: 'relative', background: `${ink}04`, border: `0.5px solid ${ink}11`, padding: 24, display: 'grid', gap: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.18em', textTransform: 'uppercase', color: muted }}>
                  <span>F-{String(i + 1).padStart(2, '0')}</span><span>Insert</span>
                </div>
                <div style={{ height: 180, position: 'relative' }}><CabFeatureIcon theme={theme} kind={f.icon} /></div>
                <div>
                  <div style={{ font: '400 20px/1.15 var(--font-heading)', color: ink, letterSpacing: '-0.01em' }}>{f.name}</div>
                  <div style={{ font: '400 13px/1.45 var(--font-body)', color: `${ink}bb`, marginTop: 6 }}>{f.blurb}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      );
    }

    function CabFinishCard({ theme, f }) {
      const { ink, paper, accent, muted } = theme;
      const [hover, setHover] = useState(false);
      const dark = (() => { if (!f.fill) return false; const hex = f.fill.replace('#', ''); const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16); return (r * 0.299 + g * 0.587 + b * 0.114) < 130; })();
      const overlayText = dark ? paper : ink;
      return (
        <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ position: 'relative', height: 240, overflow: 'hidden', background: paper, boxShadow: `0 0 0 0.5px ${ink}22, 0 ${hover ? 14 : 0}px ${hover ? 28 : 0}px ${ink}1a`, transition: 'box-shadow .2s, transform .2s', transform: hover ? 'translateY(-4px)' : 'none' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 164, overflow: 'hidden' }}>
            {f.wood ? <div style={{ position: 'absolute', inset: 0, ...materialFace('wood', f.tone) }} /> : <div style={{ position: 'absolute', inset: 0, background: f.fill }} />}
            {f.family === 'gloss' && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.1) 35%, transparent 60%, rgba(0,0,0,0.22) 100%)' }} />}
            {f.family === 'textured' && <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(rgba(0,0,0,0.18) 1px, transparent 1.4px), radial-gradient(rgba(255,255,255,0.15) 1px, transparent 1.4px)', backgroundSize: '6px 6px, 9px 9px', backgroundPosition: '0 0, 3px 3px', mixBlendMode: 'overlay' }} />}
            {f.family === 'matte' && <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 60px rgba(0,0,0,0.08)' }} />}
            <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', alignItems: 'center', gap: 6, font: '500 9px/1 ui-monospace, monospace', letterSpacing: '0.14em', textTransform: 'uppercase', color: overlayText, opacity: 0.85 }}>
              <span style={{ padding: '3px 6px', border: `0.5px solid ${overlayText}55`, borderRadius: 2 }}>{f.brand === 'waypoint' ? 'WP' : 'EU'}</span>
              <span>{f.family}{f.species ? ` · ${f.species}` : ''}</span>
            </div>
          </div>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 76, padding: '14px 14px', background: paper, borderTop: `0.5px solid ${ink}11`, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }} title={f.name}>
            <div style={{ font: '400 15px/1.15 var(--font-heading)', color: ink, letterSpacing: '-0.005em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, font: '500 9px/1 ui-monospace, monospace', letterSpacing: '0.1em', textTransform: 'uppercase', color: muted }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.fill.toUpperCase()}</span>
              <span style={{ color: accent, whiteSpace: 'nowrap', flexShrink: 0 }}>{'\u2192'}</span>
            </div>
          </div>
        </div>
      );
    }

    function CabFinishes({ theme }) {
      const { ink, paper, accent, muted } = theme;
      const all = [...CAB_BRANDS.waypoint.finishes.map(f => ({ ...f, brand: 'waypoint' })), ...CAB_BRANDS.europa.finishes.map(f => ({ ...f, brand: 'europa' }))];
      const [filter, setFilter] = useState('all');
      const filters = [{ id: 'all', l: 'All' }, { id: 'waypoint', l: 'Waypoint' }, { id: 'europa', l: 'Europa' }, { id: 'painted', l: 'Painted' }, { id: 'stained', l: 'Stained' }, { id: 'matte', l: 'Matte' }, { id: 'gloss', l: 'Gloss' }, { id: 'veneer', l: 'Veneer' }, { id: 'textured', l: 'Textured' }];
      const shown = all.filter(f => filter === 'all' || filter === f.brand || filter === f.family);
      return (
        <section style={{ padding: '120px 80px', background: `${ink}05`, borderTop: `0.5px solid ${ink}11` }}>
          <CabSectionHead theme={theme} num="05" eyebrow="Finishes" headline={<><em style={{ color: accent }}>{all.length}</em> ways to wear it.</>} sub={"Painted, stained, matte, gloss, real-wood veneer, textured concrete. All physically stocked in the showroom \u2014 request any as a 5\u2033 door sample, free."} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 28, alignItems: 'baseline' }}>
            {filters.map(ft => {
              const active = filter === ft.id;
              const count = ft.id === 'all' ? all.length : all.filter(f => ft.id === f.brand || ft.id === f.family).length;
              return (<button key={ft.id} onClick={() => setFilter(ft.id)} style={{ padding: '9px 14px', borderRadius: 999, cursor: 'pointer', border: `0.5px solid ${active ? accent : ink + '22'}`, background: active ? accent : 'transparent', color: active ? paper : ink, font: '500 11px/1 var(--font-body)', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: 8, transition: 'all .15s' }}>
                {ft.l}<span style={{ font: '500 9px/1 ui-monospace, monospace', letterSpacing: '0.08em', opacity: 0.6 }}>{count}</span>
              </button>);
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
            {shown.map(f => <CabFinishCard key={`${f.brand}-${f.id}`} theme={theme} f={f} />)}
          </div>
        </section>
      );
    }

    function CabCompare({ theme, setBrand }) {
      const { ink, paper, accent, muted } = theme;
      const rows = [
        { label: 'Construction', w: 'Face-frame, \u00BE\u2033 ply box', e: 'Frameless, 19mm full-overlay' },
        { label: 'Door styles', w: '6 styles: shaker, recessed, raised, beaded, arched, mullion', e: '6 styles: slab, channel, slim, gloss, reeded, glass' },
        { label: 'Finishes', w: '25 total · 12 paints · 12 stains', e: '23 total · 14 mattes · 3 glosses · 4 veneers · 2 textured' },
        { label: 'Drawer guides', w: 'Blum Tandem full-extension', e: 'Blum Legrabox full-extension' },
        { label: 'Soft-close', w: 'Standard, all doors & drawers', e: 'Standard, push-to-open optional' },
        { label: 'Hardware', w: 'Knobs, bar pulls, cup pulls', e: 'Integrated channel, slim bar, push-to-open' },
        { label: 'Custom paint', w: 'No (8 standard colors)', e: 'Yes, any RAL or Pantone (+$45 /opening)' },
        { label: 'Warranty', w: 'Lifetime', e: '10-year' },
        { label: 'Lead time', w: '5\u20137 weeks', e: '4\u20136 weeks' },
        { label: 'Made in', w: 'Cumberland, MD · USA', e: 'Italian-engineered, assembled in Mexico' },
        { label: 'Starting at', w: '$240 / lf', e: '$320 / lf' },
      ];
      return (
        <section style={{ padding: '120px 80px', background: paper, borderTop: `0.5px solid ${ink}11` }}>
          <CabSectionHead theme={theme} num="06" eyebrow="The fine print" headline={<>Side by side, <em style={{ color: accent }}>row by row.</em></>} sub="The spec sheet, exposed." />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderTop: `0.5px solid ${ink}22` }}>
            <div style={{ padding: '20px 0' }}><div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted }}>Spec</div></div>
            <div style={{ padding: '20px 24px', borderLeft: `0.5px solid ${ink}22` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: ink }} />Waypoint</div>
              <div style={{ font: '400 22px/1 var(--font-heading)', color: ink }}>Face-frame</div>
            </div>
            <div style={{ padding: '20px 24px', borderLeft: `0.5px solid ${ink}22`, background: `${accent}06` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.2em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: accent }} />Europa</div>
              <div style={{ font: '400 22px/1 var(--font-heading)', color: ink }}>Frameless</div>
            </div>
            {rows.map((r, i) => (
              <React.Fragment key={i}>
                <div style={{ padding: '18px 0', borderTop: `0.5px solid ${ink}11`, font: '500 10px/1.2 ui-monospace, monospace', letterSpacing: '0.16em', textTransform: 'uppercase', color: muted }}>{r.label}</div>
                <div style={{ padding: '18px 24px', borderTop: `0.5px solid ${ink}11`, borderLeft: `0.5px solid ${ink}22`, font: '400 15px/1.4 var(--font-heading)', color: ink }}>{r.w}</div>
                <div style={{ padding: '18px 24px', borderTop: `0.5px solid ${ink}11`, borderLeft: `0.5px solid ${ink}22`, font: '400 15px/1.4 var(--font-heading)', color: ink, background: `${accent}06` }}>{r.e}</div>
              </React.Fragment>
            ))}
          </div>
          <div style={{ marginTop: 32, padding: '24px 28px', background: `${ink}05`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ font: '500 10px/1 ui-monospace, monospace', letterSpacing: '0.18em', textTransform: 'uppercase', color: muted, marginBottom: 6 }}>Still deciding?</div>
              <div style={{ font: '400 22px/1.2 var(--font-heading)', color: ink }}>Order a sample door from each. They're free, they arrive in a week.</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setBrand('waypoint')} style={cabBtn(ink, paper, 'primary', theme)}>Waypoint sample</button>
              <button onClick={() => setBrand('europa')} style={cabBtn(accent, paper, 'primary', theme)}>Europa sample</button>
            </div>
          </div>
        </section>
      );
    }

    function CabCTA({ theme }) {
      const { ink, paper, accent, muted } = theme;
      return (
        <section style={{ padding: '120px 80px', background: ink, color: paper, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -160, right: -120, width: 520, height: 520, borderRadius: '50%', background: `radial-gradient(circle at 30% 30%, ${accent}38, transparent 70%)` }} />
          <div style={{ position: 'relative' }}>
            <div style={{ font: '500 11px/1 ui-monospace, monospace', letterSpacing: '0.22em', textTransform: 'uppercase', color: accent, marginBottom: 24 }}>07 · The showroom</div>
            <h2 style={{ font: '300 84px/0.92 var(--font-heading)', margin: 0, letterSpacing: '-0.02em', color: paper, maxWidth: 1100 }}>
              Touch the doors. <em style={{ color: accent, fontStyle: 'italic' }}>Open the drawers.</em><br />
              <span style={{ color: `${paper}aa`, fontStyle: 'italic' }}>Then build a kitchen.</span>
            </h2>
            <p style={{ font: '400 18px/1.55 var(--font-body)', color: `${paper}cc`, margin: '32px 0 0', maxWidth: 640 }}>
              A full Waypoint and Europa wall lives in our Anaheim showroom — every door style, every finish, every hinge, ready to be opened, slammed shut, and judged in person. Bring a paint chip. Bring a cabinet maker. We'll meet you there.
            </p>
            <div style={{ display: 'flex', gap: 14, marginTop: 44, flexWrap: 'wrap' }}>
              <button style={cabBtn(accent, paper, 'primary', theme)}>Book a design consult</button>
              <button style={{ ...cabBtn(paper, ink, 'primary', theme), background: 'transparent', color: paper, border: `0.5px solid ${paper}55` }}>Order sample doors</button>
              <button style={{ ...cabBtn(paper, ink, 'primary', theme), background: 'transparent', color: paper, border: `0.5px solid ${paper}55` }}>Visit the showroom</button>
            </div>
            <div style={{ marginTop: 64, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, paddingTop: 32, borderTop: `0.5px solid ${paper}22` }}>
              {[{ v: 'Mon\u2013Sat', l: '9 am \u2013 6 pm' }, { v: '1440', l: 'S. State College, Anaheim' }, { v: '(714) 999-0009', l: 'Showroom direct' }, { v: 'Free', l: 'Sample door program' }].map((it, i) => (
                <div key={i} style={{ paddingLeft: i === 0 ? 0 : 24, borderLeft: i === 0 ? 'none' : `0.5px solid ${paper}22` }}>
                  <div style={{ font: '400 22px/1.1 var(--font-heading)', color: paper }}>{it.v}</div>
                  <div style={{ font: '500 11px/1.3 var(--font-body)', color: `${paper}88`, marginTop: 6 }}>{it.l}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      );
    }

    function CabinetsPage() {
      const [brand, setBrand] = useState('waypoint');
      const theme = { ink: '#1c1917', paper: '#ece5d8', accent: '#a87935', muted: '#8a7e6b' };
      useEffect(() => {
        updateSEO({ title: 'Custom Cabinets | Roma Flooring Designs', description: 'Waypoint face-frame and Europa frameless cabinetry — designed in-house, installed by our crew. Visit our Anaheim showroom.', url: SITE_URL + '/cabinets' });
      }, []);
      return (
        <div className="cab-page" style={{ background: theme.paper, color: theme.ink, fontFamily: 'var(--font-body)' }}>
          <CabHero theme={theme} brand={brand} setBrand={setBrand} />
          <CabAnatomy theme={theme} />
          <CabConfigurator theme={theme} brand={brand} setBrand={setBrand} />
          <CabFeatures theme={theme} />
          <CabFinishes theme={theme} />
          <CabCompare theme={theme} setBrand={setBrand} />
          <CabCTA theme={theme} />
        </div>
      );
    }

    // ==================== Global broken-image handler ====================
    // Delegated listener hides any <img> that fails to load (vendor CDN 404s,
    // Cloudinary missing assets, etc.) so no broken-icon placeholders appear.
    document.addEventListener('error', function(e) {
      if (e.target.tagName === 'IMG') e.target.style.display = 'none';
    }, true);

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
      const [searchTimeMs, setSearchTimeMs] = useState(null);
      const [relatedSearches, setRelatedSearches] = useState([]);
      const [matchingCategories, setMatchingCategories] = useState([]);
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
      const [liftgateEnabled, setLiftgateEnabled] = useState(true);
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
      const [klarnaFinalizing, setKlarnaFinalizing] = useState(false);
      const [klarnaError, setKlarnaError] = useState('');

      // Toast notifications
      const [toasts, setToasts] = useState([]);
      const toastIdRef = useRef(0);
      const toastTimersRef = useRef([]);
      const showToast = useCallback((message, type = 'info', duration = 3500) => {
        const id = ++toastIdRef.current;
        setToasts(prev => [...prev, { id, message, type, leaving: false }]);
        const t1 = setTimeout(() => {
          setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
          const t2 = setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
          toastTimersRef.current.push(t2);
        }, duration);
        toastTimersRef.current.push(t1);
      }, []);
      useEffect(() => () => { toastTimersRef.current.forEach(t => clearTimeout(t)); }, []);

      // Wishlist
      const [wishlist, setWishlist] = useState(() => {
        try { return JSON.parse(localStorage.getItem('wishlist') || '[]'); } catch(e) { return []; }
      });

      // Recently viewed
      const [recentlyViewed, setRecentlyViewed] = useState(() => {
        try { return JSON.parse(localStorage.getItem('recently_viewed') || '[]'); } catch(e) { return []; }
      });
      const addRecentlyViewed = (skuData) => {
        setRecentlyViewed(prev => {
          const filtered = prev.filter(s => s.sku_id !== skuData.sku_id);
          const updated = [{ sku_id: skuData.sku_id, product_name: skuData.product_name, variant_name: skuData.variant_name, primary_image: skuData.primary_image, retail_price: skuData.retail_price, cut_price: skuData.cut_price, price_basis: skuData.price_basis, sell_by: skuData.sell_by, sqft_per_box: skuData.sqft_per_box }, ...filtered].slice(0, 12);
          try { localStorage.setItem('recently_viewed', JSON.stringify(updated)); } catch(e) { /* quota exceeded */ }
          return updated;
        });
      };

      const sessionId = useRef(getSessionId());
      const scrollY = useRef(0);
      const pendingScroll = useRef(null);

      // ---- Consent-gated analytics ----
      // Emits to /api/analytics/*, but never when the visitor has declined
      // cookies. Consent is read live from localStorage on every call, so a
      // Decline click stops tracking immediately for the rest of the session.
      const analyticsAllowed = () => {
        try { return localStorage.getItem('cookie_consent') !== 'declined'; } catch (e) { return false; }
      };
      const getVisitorId = () => {
        try {
          let vid = localStorage.getItem('analytics_visitor_id');
          if (!vid) {
            vid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('v_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
            localStorage.setItem('analytics_visitor_id', vid);
          }
          return vid;
        } catch (e) { return null; }
      };
      const track = (event_type, properties) => {
        if (!analyticsAllowed()) return;
        try {
          fetch(API + '/api/analytics/event', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
            body: JSON.stringify({ events: [{
              event_type, properties: properties || {},
              session_id: sessionId.current, visitor_id: getVisitorId(),
              page_path: window.location.pathname, referrer: document.referrer || null,
            }] })
          }).catch(() => {});
        } catch (e) {}
      };
      const pingSession = () => {
        if (!analyticsAllowed()) return;
        try {
          const sp = new URLSearchParams(window.location.search);
          const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
          fetch(API + '/api/analytics/session', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
            body: JSON.stringify({
              session_id: sessionId.current, visitor_id: getVisitorId(),
              user_agent: navigator.userAgent, referrer: document.referrer || null,
              device_type: window.innerWidth < 768 ? 'mobile' : (isTouch && window.innerWidth < 1024 ? 'tablet' : 'desktop'),
              utm_source: sp.get('utm_source'), utm_medium: sp.get('utm_medium'), utm_campaign: sp.get('utm_campaign'),
            })
          }).catch(() => {});
        } catch (e) {}
      };

      // Session ping on load; page_view whenever the view changes.
      useEffect(() => { pingSession(); }, []);
      useEffect(() => { track('page_view', { view }); }, [view]);

      const tradeHeaders = () => {
        const t = localStorage.getItem('trade_token');
        return t ? { 'X-Trade-Token': t } : {};
      };

      // ---- Stable refs for popstate handler ----
      const fetchSkusRef = useRef(null);
      const fetchFacetsRef = useRef(null);
      const fetchSkusAbort = useRef(null);
      const fetchFacetsAbort = useRef(null);

      // ---- Fetch SKUs ----
      const fetchSkus = useCallback((opts = {}) => {
        const PAGE_SIZE = 24;
        const { cat, coll, search, activeFilters, sort, page, vendors, priceMin, priceMax, tags } = {
          cat: selectedCategory, coll: selectedCollection, search: searchQuery,
          activeFilters: filters, sort: sortBy, page: currentPage,
          vendors: vendorFilters, priceMin: userPriceRange.min, priceMax: userPriceRange.max, tags: tagFilters, ...opts
        };
        const params = new URLSearchParams();
        if (cat) params.set('category', cat);
        if (coll) params.set('collection', coll);
        if (search) params.set('q', search);
        if (sort && sort !== 'relevance') params.set('sort', sort);
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String((page - 1) * PAGE_SIZE));
        const af = activeFilters || {};
        Object.keys(af).forEach(slug => {
          if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join('|'));
        });
        const vf = vendors || [];
        if (vf.length > 0) params.set('brand', vf.join('|'));
        if (priceMin != null) params.set('price_min', String(priceMin));
        if (priceMax != null) params.set('price_max', String(priceMax));
        const tf = tags || [];
        if (tf.length > 0) params.set('tags', tf.join('|'));

        if (fetchSkusAbort.current) fetchSkusAbort.current.abort();
        const controller = new AbortController();
        fetchSkusAbort.current = controller;
        setLoadingSkus(true);
        fetch(API + '/api/storefront/skus?' + params.toString(), { headers: tradeHeaders(), signal: controller.signal })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            setSkus(data.skus || []);
            setTotalSkus(data.total || 0);
            setSearchDidYouMean(data.didYouMean || null);
            setSearchTimeMs(data.searchTimeMs != null ? data.searchTimeMs : null);
            setLoadingSkus(false);
            if (pendingScroll.current !== null) {
              const pos = pendingScroll.current;
              pendingScroll.current = null;
              requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, pos)));
            }
          })
          .catch(err => { if (err.name !== 'AbortError') { console.error(err); setLoadingSkus(false); } });
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
        if (vf.length > 0) params.set('brand', vf.join('|'));
        if (priceMin != null) params.set('price_min', String(priceMin));
        if (priceMax != null) params.set('price_max', String(priceMax));
        const tf = tags || [];
        if (tf.length > 0) params.set('tags', tf.join('|'));

        if (fetchFacetsAbort.current) fetchFacetsAbort.current.abort();
        const facetController = new AbortController();
        fetchFacetsAbort.current = facetController;
        fetch(API + '/api/storefront/facets?' + params.toString(), { signal: facetController.signal })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            setFacets(data.facets || []);
            setVendorFacets(data.brands || data.vendors || []);
            setTagFacets(data.tags || []);
            if (data.priceRange) setPriceRange(data.priceRange);
          })
          .catch(err => { if (err.name !== 'AbortError') console.error(err); });
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => setCart(data.cart || []))
          .catch(err => console.error(err));
      };

      const addToCart = (item) => {
        fetch(API + '/api/cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...item, session_id: sessionId.current })
        })
          .then(r => r.json().then(data => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || data.error) { showToast(data.error || 'Failed to add to cart', 'error'); return; }
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
              track('add_to_cart', { sku_id: item.sku_id, is_sample: !!item.is_sample });
            }
          })
          .catch(err => console.error(err));
      };

      const removeFromCart = (itemId) => {
        fetch(API + '/api/cart/' + itemId + '?session_id=' + encodeURIComponent(sessionId.current), { method: 'DELETE' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(() => setCart(prev => prev.filter(i => i.id !== itemId)))
          .catch(err => console.error(err));
      };

      const updateCartItem = (itemId, updates) => {
        fetch(API + '/api/cart/' + itemId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...updates, session_id: sessionId.current })
        })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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

      const handleCustomerLogin = (token, cust, remember) => {
        if (remember === false) {
          sessionStorage.setItem('customer_token', token);
          localStorage.removeItem('customer_token');
        } else {
          localStorage.setItem('customer_token', token);
        }
        setCustomerToken(token);
        setCustomer(cust);
        setShowAuthModal(false);
        syncWishlistOnLogin(token);
        if (view === 'signin' || view === 'signup' || view === 'set-password' || view === 'reset-password') {
          setView('account');
          history.pushState({ view: 'account' }, '', '/account');
          window.scrollTo(0, 0);
        }
      };

      const handleCustomerLogout = () => {
        const t = localStorage.getItem('customer_token') || sessionStorage.getItem('customer_token');
        if (t) fetch(API + '/api/customer/logout', { method: 'POST', headers: { 'X-Customer-Token': t } }).catch(() => {});
        localStorage.removeItem('customer_token');
        sessionStorage.removeItem('customer_token');
        setCustomerToken(null);
        setCustomer(null);
      };

      // ---- Wishlist ----
      const toggleWishlist = (skuId) => {
        const isWished = wishlist.includes(skuId);
        let updated;
        if (isWished) {
          updated = wishlist.filter(id => id !== skuId);
          showToast('Removed from wishlist', 'info');
        } else {
          updated = [skuId, ...wishlist];
          showToast('Added to wishlist', 'success');
        }
        setWishlist(updated);
        try { localStorage.setItem('wishlist', JSON.stringify(updated)); } catch(e) { /* quota exceeded */ }
        const custToken = localStorage.getItem('customer_token');
        if (custToken) {
          if (isWished) {
            fetch(API + '/api/wishlist/' + skuId, { method: 'DELETE', headers: { 'X-Customer-Token': custToken } }).catch(() => {});
          } else {
            fetch(API + '/api/wishlist', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Customer-Token': custToken },
              body: JSON.stringify({ sku_id: skuId })
            }).catch(() => {});
          }
        }
      };

      const syncWishlistOnLogin = (token) => {
        let localWishlist;
        try { localWishlist = JSON.parse(localStorage.getItem('wishlist') || '[]'); } catch(e) { localWishlist = []; }
        if (localWishlist.length > 0) {
          fetch(API + '/api/wishlist/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Customer-Token': token },
            body: JSON.stringify({ sku_ids: localWishlist })
          })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            if (data.sku_ids) {
              setWishlist(data.sku_ids);
              localStorage.setItem('wishlist', JSON.stringify(data.sku_ids));
            }
          })
          .catch(() => {});
        } else {
          fetch(API + '/api/wishlist', { headers: { 'X-Customer-Token': token } })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            if (data.sku_ids) {
              setWishlist(data.sku_ids);
              localStorage.setItem('wishlist', JSON.stringify(data.sku_ids));
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

      const goCabinets = () => {
        setView('cabinets');
        history.pushState({ view: 'cabinets' }, '', '/cabinets');
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
        }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(() => {
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
        if (path === '/signin' || path === '/signup' || path === '/forgot-password') {
          const viewName = path.slice(1);
          setView(viewName);
          history.pushState({ view: viewName }, '', path);
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
        if (path === '/cabinets') {
          goCabinets();
          return;
        }
        if (path === '/terms' || path === '/privacy') {
          const viewName = path.slice(1);
          setView(viewName);
          history.pushState({ view: viewName }, '', path);
          window.scrollTo(0, 0);
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
        setSelectedCategory(null);
        history.pushState({ view: 'browse' }, '', '/shop');
        window.scrollTo(0, 0);
      };

      const goSkuDetail = (skuId, productName) => {
        const fromDetail = view === 'detail';
        if (view === 'browse' || view === 'home') scrollY.current = window.scrollY;
        setSelectedSkuId(skuId);
        setView('detail');
        const slug = generateSlug(productName || 'product');
        history.pushState({ view: 'detail', skuId, _fromDetail: fromDetail }, '', '/shop/sku/' + skuId + '/' + slug);
        window.scrollTo(0, 0);
        track('product_view', { sku_id: skuId });
      };

      const goBackToBrowse = () => {
        // Use browser history when the previous page was also a detail page (e.g. navigating back from accessory)
        const prev = history.state;
        if (prev && prev._fromDetail) {
          history.back();
          return;
        }
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
        track('checkout_started', { item_count: cart.length });
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
        history.pushState({ view: 'confirmation' }, '', '/checkout/confirmation');
        window.scrollTo(0, 0);
        track('order_completed', { order_number: orderData && orderData.order ? orderData.order.order_number : undefined });
        fetch(API + '/api/cart/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId.current })
        }).catch(() => {});
      };

      // Finalize a Klarna order after the redirect back from Klarna. The
      // order payload was stashed before redirecting (React state is lost
      // across the redirect); we place the order once Klarna authorizes.
      const finalizeKlarnaOrder = async (paymentIntentId, redirectStatus) => {
        const raw = sessionStorage.getItem('klarna_pending');
        sessionStorage.removeItem('klarna_pending');
        history.replaceState({ view: 'checkout' }, '', '/checkout');
        if (redirectStatus === 'failed' || !raw) {
          setView('checkout');
          setKlarnaError("Your Klarna payment wasn't completed. You can try again or choose another payment method.");
          return;
        }
        setView('checkout');
        setKlarnaFinalizing(true);
        try {
          const stash = JSON.parse(raw);
          const orderBody = { ...stash.orderBody, payment_intent_id: paymentIntentId, payment_method: 'klarna' };
          const headers = { 'Content-Type': 'application/json' };
          if (tradeToken) headers['X-Trade-Token'] = tradeToken;
          if (customerToken) headers['X-Customer-Token'] = customerToken;
          const res = await fetch(API + '/api/checkout/place-order', { method: 'POST', headers, body: JSON.stringify(orderBody) });
          const data = await res.json();
          if (data.error) { setKlarnaError(data.error); setKlarnaFinalizing(false); return; }
          if (data.customer_token && data.customer) handleCustomerLogin(data.customer_token, data.customer);
          setKlarnaFinalizing(false);
          handleOrderComplete({ order: data.order, sample_request: data.sample_request || null });
        } catch (e) {
          setKlarnaError("We couldn't finalize your Klarna order. If you were charged, please call (714) 999-0009 — no order was created.");
          setKlarnaFinalizing(false);
        }
      };

      // ---- Filter Handlers ----
      const handleCategorySelect = (slug) => {
        setSelectedCategory(slug);
        setSelectedCollection(null);
        setSearchQuery('');
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        setSortBy('name_asc');
        setRelatedSearches([]);
        setMatchingCategories([]);
        fetchSkus({ cat: slug, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: 'name_asc' });
        fetchFacets({ cat: slug, coll: null, search: '', activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(slug, null, '', {}, false, [], null, null, []);
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

      const handleBatchFilterSet = (slug, values) => {
        setFilters(prev => {
          const updated = { ...prev };
          if (values.length > 0) updated[slug] = values;
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
        track('search', { query: query });
        setSearchQuery(query);
        setSearchDidYouMean(null);
        setSelectedCategory(null);
        setSelectedCollection(null);
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        setSortBy('relevance');
        setView('browse');
        fetchSkus({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: 'relevance' });
        fetchFacets({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        pushShopUrl(null, null, query, {}, false, [], null, null, []);
        // Fetch related searches
        setRelatedSearches([]);
        fetch(API + '/api/storefront/search/related?q=' + encodeURIComponent(query))
          .then(r => r.ok ? r.json() : { terms: [] })
          .then(d => setRelatedSearches(d.terms || []))
          .catch(() => {});
        // Fetch matching categories from suggest for quick filter pills
        fetch(API + '/api/storefront/search/suggest?q=' + encodeURIComponent(query))
          .then(r => r.ok ? r.json() : { categories: [] })
          .then(d => setMatchingCategories(d.categories || []))
          .catch(() => {});
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
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
        window.scrollTo(0, 0);
        fetchCart();

        fetch(API + '/api/categories').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
        const savedCustToken = localStorage.getItem('customer_token') || sessionStorage.getItem('customer_token');
        if (savedCustToken) {
          fetch(API + '/api/customer/me', { headers: { 'X-Customer-Token': savedCustToken } })
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(data => { setCustomer(data.customer); setCustomerToken(savedCustToken); })
            .catch(() => { localStorage.removeItem('customer_token'); sessionStorage.removeItem('customer_token'); setCustomerToken(null); });
        }

        // Fetch featured SKUs for homepage (best-sellers with newest fallback)
        fetch(API + '/api/storefront/featured')
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { setFeaturedSkus(data.skus || []); setFeaturedLoading(false); })
          .catch(() => { setFeaturedLoading(false); });

        // Fetch global facets for axis navigation (By Look, By Color, By Size)
        fetch(API + '/api/storefront/facets')
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => setGlobalFacets(data.facets || []))
          .catch(console.error);

        // Parse URL
        const rawPath = window.location.pathname;
        const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
        const sp = new URLSearchParams(window.location.search);

        if (sp.get('payment_intent') && sp.get('redirect_status') && sessionStorage.getItem('klarna_pending')) {
          // Returned from Klarna's hosted authorization page
          finalizeKlarnaOrder(sp.get('payment_intent'), sp.get('redirect_status'));
        } else if (sp.get('reset_token')) {
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
        } else if (path === '/account' && sp.get('action') === 'set-password' && sp.get('token')) {
          setView('set-password');
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
        } else if (path === '/signin') {
          setView('signin');
        } else if (path === '/signup') {
          setView('signup');
        } else if (path === '/forgot-password') {
          setView('forgot-password');
        } else if (path === '/installation') {
          setView('installation');
        } else if (path === '/inspiration') {
          setView('inspiration');
        } else if (path === '/sale') {
          setView('sale');
        } else if (path === '/cabinets') {
          setView('cabinets');
        } else if (path === '/terms') {
          setView('terms');
        } else if (path === '/privacy') {
          setView('privacy');
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
          if (q) { setSearchQuery(q); setSortBy('relevance'); }
          if (Object.keys(af).length) setFilters(af);
          if (vf.length) setVendorFilters(vf);
          if (tf.length) setTagFilters(tf);
          if (prMin != null || prMax != null) setUserPriceRange({ min: prMin, max: prMax });
          if (cat || coll || q || Object.keys(af).length > 0 || vf.length > 0 || tf.length > 0) {
            fetchSkus({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, sort: q ? 'relevance' : undefined });
            fetchFacets({ cat, coll, search: q || '', activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
            // Fetch related searches & matching categories for URL-based search
            if (q) {
              fetch(API + '/api/storefront/search/related?q=' + encodeURIComponent(q))
                .then(r => r.ok ? r.json() : { terms: [] })
                .then(d => setRelatedSearches(d.terms || []))
                .catch(() => {});
              fetch(API + '/api/storefront/search/suggest?q=' + encodeURIComponent(q))
                .then(r => r.ok ? r.json() : { categories: [] })
                .then(d => setMatchingCategories(d.categories || []))
                .catch(() => {});
            }
          }
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
            const rawP = window.location.pathname;
            const p = rawP.length > 1 && rawP.endsWith('/') ? rawP.slice(0, -1) : rawP;
            if (p === '/' || p === '') { setView('home'); }
            else if (p.startsWith('/shop/sku/')) {
              const parts = p.replace('/shop/sku/', '').split('/');
              setSelectedSkuId(parts[0]);
              setView('detail');
            } else if (p === '/trade') { setView('trade'); }
            else if (p === '/trade/dashboard') { setView('trade-dashboard'); }
            else if (p === '/sale') { setView('sale'); }
            else if (p === '/cabinets') { setView('cabinets'); }
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
          signin: { title: 'Sign In | Roma Flooring Designs', description: 'Sign in to your Roma Flooring Designs account.', url: SITE_URL + '/signin' },
          signup: { title: 'Create Account | Roma Flooring Designs', description: 'Create your Roma Flooring Designs account.', url: SITE_URL + '/signup' },
          'forgot-password': { title: 'Forgot Password | Roma Flooring Designs', description: 'Reset your Roma Flooring Designs password.', url: SITE_URL + '/forgot-password' },
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

      const isAuthPage = view === 'signin' || view === 'signup' || view === 'forgot-password' || view === 'set-password';
      const isCheckoutFlow = view === 'checkout' || view === 'confirmation' || isAuthPage;

      return (
        <>
          {!isCheckoutFlow && <Header
            goHome={goHome} goBrowse={goBrowse} cart={cart}
            cartDrawerOpen={cartDrawerOpen} setCartDrawerOpen={setCartDrawerOpen}
            cartFlash={cartFlash}
            onSearch={handleSearch} onSkuClick={goSkuDetail}
            tradeCustomer={tradeCustomer}
            onTradeClick={tradeCustomer ? goTradeDashboard : goTrade}
            onTradeLogout={handleTradeLogout}
            customer={customer}
            onAccountClick={customer ? goAccount : () => navigate('/signin')}
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
          />}

          {view === 'home' && (
            <HomePage
              featuredSkus={featuredSkus}
              featuredLoading={featuredLoading}
              categories={categories}
              onSkuClick={goSkuDetail}
              onCategorySelect={(slug) => { handleCategorySelect(slug); setView('browse'); }}
              goBrowse={goBrowse}
              goTrade={goTrade}
              goCabinets={goCabinets}
              navigate={navigate}
              wishlist={wishlist} toggleWishlist={toggleWishlist}
              setQuickViewSku={setQuickViewSku}
              newsletterEmail={newsletterEmail} setNewsletterEmail={setNewsletterEmail}
              newsletterSubmitted={newsletterSubmitted} onNewsletterSubmit={handleNewsletterSubmit}
              onOpenQuiz={() => setShowFloorQuiz(true)}
            />
          )}

          {view === 'browse' && (
            (!selectedCategory && !selectedCollection && !searchQuery) ? (
              <ShopLanding
                categories={categories}
                featuredSkus={featuredSkus} featuredLoading={featuredLoading}
                onCategorySelect={(slug) => { handleCategorySelect(slug); setView('browse'); }}
                onSkuClick={goSkuDetail}
                goTrade={goTrade} navigate={navigate}
              />
            ) : (
              <BrowseView
                skus={skus} totalSkus={totalSkus} loading={loadingSkus}
                categories={categories} selectedCategory={selectedCategory}
                selectedCollection={selectedCollection} searchQuery={searchQuery}
                onCategorySelect={handleCategorySelect} onSearch={handleSearch}
                facets={facets} filters={filters}
                onFilterToggle={handleFilterToggle} onBatchFilterSet={handleBatchFilterSet} onClearFilters={handleClearFilters}
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
                searchTimeMs={searchTimeMs} relatedSearches={relatedSearches} matchingCategories={matchingCategories}
              />
            )
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
              liftgateEnabled={liftgateEnabled} setLiftgateEnabled={setLiftgateEnabled}
              sessionId={sessionId.current} appliedPromoCode={appliedPromoCode} setAppliedPromoCode={setAppliedPromoCode}
              goHome={goHome} />
          )}

          {view === 'checkout' && klarnaFinalizing && (
            <div style={{ maxWidth: 480, margin: '6rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
              <div className="spinner" style={{ margin: '0 auto 1.5rem' }} />
              <h2 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: '1.75rem', fontWeight: 400, marginBottom: '0.5rem' }}>Completing your order</h2>
              <p style={{ color: 'var(--stone-600)', fontSize: '0.9375rem' }}>Confirming your Klarna payment — just a moment.</p>
            </div>
          )}
          {view === 'checkout' && !klarnaFinalizing && (
            <CheckoutPage cart={cart} sessionId={sessionId.current}
              goCart={goCart} handleOrderComplete={handleOrderComplete}
              deliveryMethod={deliveryMethod} setDeliveryMethod={setDeliveryMethod} liftgateEnabled={liftgateEnabled}
              tradeCustomer={tradeCustomer} tradeToken={tradeToken}
              customer={customer} customerToken={customerToken}
              onCustomerLogin={handleCustomerLogin}
              klarnaError={klarnaError} clearKlarnaError={() => setKlarnaError('')}
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
            <ResetPasswordPage goHome={goHome} onLogin={handleCustomerLogin} openLogin={() => { setAuthModalMode('login'); setShowAuthModal(true); }} />
          )}

          {view === 'set-password' && (
            <SetPasswordPage onLogin={handleCustomerLogin} goHome={goHome} navigate={navigate} />
          )}

          {view === 'signin' && (
            <SignInFullPage onLogin={handleCustomerLogin} goHome={goHome} navigate={navigate} />
          )}

          {view === 'signup' && (
            <SignUpFullPage onLogin={handleCustomerLogin} goHome={goHome} navigate={navigate} />
          )}

          {view === 'forgot-password' && (
            <ForgotPasswordFullPage goHome={goHome} navigate={navigate} />
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

          {view === 'cabinets' && (
            <CabinetsPage />
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

          {view === 'terms' && <LegalPage kind="terms" goHome={goHome} navigate={navigate} />}
          {view === 'privacy' && <LegalPage kind="privacy" goHome={goHome} navigate={navigate} />}

          {/* Cookie consent notice */}
          <CookieConsent navigate={navigate} />

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

          {!isCheckoutFlow && <SiteFooter goHome={goHome} goBrowse={goBrowse} goCollections={goCollections} goTrade={goTrade}
            onInstallClick={goInstallation} navigate={navigate} />}

          {!isCheckoutFlow && <nav className="mobile-bottom-nav">
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
            <button className={'mobile-bottom-nav-item' + (view === 'account' ? ' active' : '')} onClick={customer ? goAccount : () => navigate('/signin')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              Account
            </button>
          </nav>}

          <BackToTop />
          <ToastContainer toasts={toasts} />
        </>
      );
    }

    // ==================== Mega Panel Data ====================

    const MEGA_PANELS = {
      services: {
        label: 'Services',
        columns: [
          { title: 'Design', items: [
            { name: 'Free In-Home Consultation', meta: 'Complimentary' },
            { name: 'Design Services', meta: 'Custom layouts' },
            { name: 'Room Visualizer', meta: 'See it in your space' },
            { name: 'Sample Program', meta: 'Try before you buy' },
          ]},
          { title: 'Installation', items: [
            { name: 'Professional Installation', meta: 'Licensed & insured' },
            { name: 'Measurement & Estimate', meta: 'Free with purchase' },
            { name: 'Demolition & Prep', meta: 'Full service' },
            { name: 'Furniture Moving', meta: 'Available' },
          ]},
          { title: 'Support', items: [
            { name: 'Financing Options', meta: '0% APR available' },
            { name: 'Commercial Projects', meta: 'Volume pricing' },
            { name: 'Warranty & Care', meta: 'Maintenance guides' },
          ]},
        ],
        featured: { title: 'Free In-Home Consultation', meta: 'Book your complimentary design visit', image: '/uploads/homepage/consult-hero.jpg', cta: 'Book Now' },
      },
      materials: {
        label: 'Materials',
        columns: [
          { title: 'Hard Surface', items: [
            { name: 'Porcelain Tile', meta: '' },
            { name: 'Ceramic Tile', meta: '' },
            { name: 'Natural Stone', meta: '' },
            { name: 'Hardwood', meta: '' },
            { name: 'Laminate', meta: '' },
            { name: 'Luxury Vinyl', meta: '' },
          ]},
          { title: 'Soft Surface', items: [
            { name: 'Carpet', meta: '' },
            { name: 'Carpet Tile', meta: '' },
            { name: 'Area Rugs', meta: '' },
          ]},
          { title: 'Surfaces', items: [
            { name: 'Countertops', meta: '' },
            { name: 'Mosaics', meta: '' },
            { name: 'Wall Tile', meta: '' },
            { name: 'Outdoor & Pavers', meta: '' },
          ]},
        ],
        featured: { title: 'New Porcelain Arrivals', meta: 'Explore the latest collections', image: '/uploads/homepage/porcelain-featured.jpg', cta: 'View Collection' },
      },
      trade: {
        label: 'Trade',
        columns: [
          { title: 'Program', items: [
            { name: 'Trade Program Overview', meta: 'Exclusive benefits', action: 'trade' },
            { name: 'Apply for Trade', meta: 'Quick approval', action: 'trade' },
            { name: 'Trade Dashboard', meta: 'Manage orders', action: 'trade' },
          ]},
          { title: 'Benefits', items: [
            { name: 'Trade Pricing', meta: 'Up to 40% off', action: 'trade' },
            { name: 'Bulk Ordering', meta: 'Volume discounts', action: 'trade' },
            { name: 'Dedicated Rep', meta: 'Personal service', action: 'trade' },
            { name: 'Net 30 Terms', meta: 'For qualified accounts', action: 'trade' },
          ]},
        ],
        featured: { title: 'Trade Program', meta: 'Join 500+ design professionals', image: '/uploads/homepage/trade-hero.jpg', cta: 'Apply Now' },
      },
    };

    // ==================== Header (2-Row Editorial) ====================

    function MegaPanel({ panelId, categories, onCategorySelect, onTradeClick, navigate, shopColumns, onEnter, onClose }) {
      if (panelId === 'shop') {
        const colCount = Math.min(shopColumns.length, 4) + 1;
        return (
          <div className="mega-panel" onMouseEnter={onEnter} onMouseLeave={onClose}>
            <div className="mega-panel-inner">
              <div className="mega-panel-grid" style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                {shopColumns.slice(0, 4).map(col => (
                  <div key={col.title} className="mega-panel-col">
                    <div className="mega-panel-col-title">{col.title}</div>
                    <div className="mega-panel-items">
                      {col.items.map(item => (
                        <button key={item.slug} className={`mega-panel-link${item.isViewAll ? ' mega-panel-view-all' : ''}`} onClick={() => onCategorySelect(item.slug)}>
                          {item.name}
                          {!item.isViewAll && item.count > 0 && <span className="mega-panel-link-meta">{item.count}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="mega-panel-featured">
                  <div className="mega-panel-featured-eyebrow">Featured</div>
                  <div className="mega-panel-featured-card" onClick={() => navigate('/shop?sort=newest')}>
                    <img src="/uploads/homepage/hero.jpg" alt="New Arrivals" loading="lazy" decoding="async" />
                    <div className="mega-panel-featured-overlay">
                      <div className="mega-panel-featured-title">New Arrivals</div>
                      <div className="mega-panel-featured-meta">Latest collections</div>
                      <div className="mega-panel-featured-cta">View &rarr;</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      const panel = MEGA_PANELS[panelId];
      if (!panel) return null;
      const colCount = panel.columns.length + (panel.featured ? 1 : 0);
      return (
        <div className="mega-panel" onMouseEnter={onEnter} onMouseLeave={onClose}>
          <div className="mega-panel-inner">
            <div className="mega-panel-grid" style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
              {panel.columns.map(col => (
                <div key={col.title} className="mega-panel-col">
                  <div className="mega-panel-col-title">{col.title}</div>
                  <div className="mega-panel-items">
                    {col.items.map(item => (
                      <button key={item.name} className="mega-panel-link" onClick={() => {
                        if (item.action === 'trade') { onTradeClick(); }
                        else if (panelId === 'materials') {
                          const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                          onCategorySelect(slug);
                        }
                        else { navigate('/shop'); }
                      }}>
                        {item.name}
                        {item.meta && <span className="mega-panel-link-meta">{item.meta}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {panel.featured && (
                <div className="mega-panel-featured">
                  <div className="mega-panel-featured-eyebrow">Featured</div>
                  <div className="mega-panel-featured-card" onClick={() => {
                    if (panelId === 'trade') onTradeClick();
                    else navigate('/shop');
                  }}>
                    <img src={panel.featured.image} alt={panel.featured.title} loading="lazy" decoding="async" />
                    <div className="mega-panel-featured-overlay">
                      <div className="mega-panel-featured-title">{panel.featured.title}</div>
                      <div className="mega-panel-featured-meta">{panel.featured.meta}</div>
                      <div className="mega-panel-featured-cta">{panel.featured.cta} &rarr;</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    function SearchPanel({ searchInput, parentCats, suggestData, suggestLoading, popularSearches, recentSearches, activeIdx, onSearch, onCategorySelect, onSkuClick, onClose, selectSuggestion, tradeCustomer, hasSuggestResults, suggestItems, navigate }) {
      const totalProducts = suggestData.categories.reduce((s, c) => s + (c.product_count || 0), 0) + suggestData.products.length;
      const clockIcon = React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
        React.createElement('circle', { cx: 12, cy: 12, r: 10 }),
        React.createElement('polyline', { points: '12 6 12 12 16 14' })
      );

      // Explore mode — no query
      if (!searchInput) {
        return (
          <div className="search-panel" onMouseDown={e => e.stopPropagation()}>
            <div className="search-panel-inner">
              <div className="search-panel-explore">
                {/* Col 1 — Recent searches */}
                <div>
                  <div className="search-panel-section-label">Recent Searches</div>
                  {recentSearches.length > 0 ? (
                    <>
                      {recentSearches.slice(0, 6).map(term => (
                        <button key={term} className="search-panel-recent-item" onClick={() => selectSuggestion({ type: 'recent', data: { term } })}>
                          {clockIcon}
                          <span>{term}</span>
                        </button>
                      ))}
                      <button className="search-panel-clear" onClick={() => { clearRecentSearches(); }}>
                        Clear recent
                      </button>
                    </>
                  ) : (
                    <div style={{ fontFamily: 'var(--font-heading)', fontSize: '0.9375rem', fontStyle: 'italic', color: 'var(--stone-400)' }}>No recent searches</div>
                  )}
                </div>
                {/* Col 2 — Trending this week */}
                <div>
                  <div className="search-panel-section-label search-panel-section-label--accent">Trending This Week</div>
                  <div className="search-panel-pills">
                    {popularSearches.slice(0, 12).map(term => (
                      <button key={term} className="search-panel-pill" onClick={() => selectSuggestion({ type: 'popular', data: { term } })}>
                        {term}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Col 3 — Browse categories */}
                <div>
                  <div className="search-panel-section-label">Browse Categories</div>
                  {parentCats.slice(0, 6).map(cat => (
                    <button key={cat.slug} className="search-panel-cat-row" onClick={() => { onClose(); onCategorySelect(cat.slug); }}>
                      <div className="search-panel-cat-swatch">
                        {cat.image ? <img src={optimizeImg(cat.image, 60)} alt="" decoding="async" loading="lazy" width={28} height={28} /> : null}
                      </div>
                      <span className="search-panel-cat-name">{cat.name}</span>
                      <span className="search-panel-cat-meta">{cat.product_count || 0}</span>
                    </button>
                  ))}
                </div>
                {/* Col 4 — Featured promo */}
                <div>
                  <div className="search-panel-section-label">Featured</div>
                  <div className="search-panel-promo" onClick={() => { onClose(); navigate('/shop?sort=newest'); }}>
                    <img src="/uploads/homepage/new-arrivals.jpg" alt="New Arrivals" loading="lazy" decoding="async" />
                    <div className="search-panel-promo-overlay" />
                    <div className="search-panel-promo-text">
                      <div className="search-panel-promo-title">New Arrivals</div>
                      <div className="search-panel-promo-desc">Latest collections just added</div>
                      <div className="search-panel-promo-bottom">
                        <span className="search-panel-promo-price">From $2.49/sqft</span>
                        <span className="search-panel-promo-cta">View &rarr;</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="search-panel-footer">
              <div className="search-panel-footer-keys">
                <span><span className="search-panel-kbd">&uarr;</span><span className="search-panel-kbd">&darr;</span> Navigate</span>
                <span><span className="search-panel-kbd">&crarr;</span> Select</span>
                <span><span className="search-panel-kbd">Esc</span> Close</span>
              </div>
              <span className="search-panel-footer-action" onClick={() => { onClose(); navigate('/shop'); }}>Search 2,400+ products</span>
            </div>
          </div>
        );
      }

      // Results mode — has query
      const isLoading = suggestLoading && !hasSuggestResults;
      const isEmpty = !suggestLoading && !hasSuggestResults && searchInput.length >= 2;
      let resultIdx = 0;

      return (
        <div className="search-panel" onMouseDown={e => e.stopPropagation()}>
          <div className="search-panel-inner">
            {isLoading && (
              <div className="search-panel-results">
                <div className="search-panel-loading">
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} className="skeleton-search-result" style={{ animationDelay: (i * 0.1) + 's' }}>
                      <div className="skeleton-search-img" />
                      <div className="skeleton-search-lines">
                        <div className="skeleton-bar skeleton-bar-short" style={{ marginTop: 0 }} />
                        <div className="skeleton-bar skeleton-bar-medium" />
                      </div>
                      <div className="skeleton-bar" style={{ width: 50, height: 12 }} />
                    </div>
                  ))}
                </div>
                <div />
              </div>
            )}
            {isEmpty && (
              <div className="search-panel-results">
                <div>
                  <div className="search-panel-empty">
                    Nothing matches yet &mdash; try{' '}
                    {popularSearches.slice(0, 3).map((term, i) => (
                      <React.Fragment key={term}>
                        {i > 0 && (i === 2 ? ', or ' : ', ')}
                        <a onClick={() => selectSuggestion({ type: 'popular', data: { term } })}>{term}</a>
                      </React.Fragment>
                    ))}
                  </div>
                  {suggestData.didYouMean && (
                    <div style={{ marginTop: '1rem' }}>
                      <div className="search-panel-section-label">Did You Mean</div>
                      <div className="search-panel-dym-item">
                        <button onClick={() => selectSuggestion({ type: 'popular', data: { term: suggestData.didYouMean } })}>{suggestData.didYouMean}</button>
                      </div>
                    </div>
                  )}
                </div>
                <div />
              </div>
            )}
            {hasSuggestResults && (
              <div className="search-panel-results">
                {/* Left — results */}
                <div>
                  {suggestData.expandedFrom && (
                    <div className="search-panel-synonym-banner">
                      Showing results for <em>{suggestData.expandedTo ? suggestData.expandedTo.split(' ').slice(0, 4).join(' ') : suggestData.expandedFrom}</em>
                      <button className="search-panel-synonym-link" onClick={() => { /* re-search without expansion — user clicks original */ selectSuggestion({ type: 'popular', data: { term: suggestData.expandedFrom } }); }}>
                        Search for &ldquo;{suggestData.expandedFrom}&rdquo; only
                      </button>
                    </div>
                  )}
                  {suggestData.autoCorrect && (
                    <div className="search-panel-autocorrect-banner">
                      Showing results for <em>{suggestData.autoCorrect.correctedQuery}</em>.{' '}
                      <button className="search-panel-synonym-link" onClick={() => selectSuggestion({ type: 'popular', data: { term: searchInput } })}>
                        Search instead for &ldquo;{searchInput}&rdquo;
                      </button>
                    </div>
                  )}
                  <div className="search-panel-section-label">
                    {suggestData.total || totalProducts} matches for &lsquo;{searchInput}&rsquo;
                  </div>
                  {suggestData.categories.map(cat => {
                    const idx = resultIdx++;
                    return (
                      <div key={cat.slug} className={'search-panel-result' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'category', data: cat })}>
                        <div className="search-panel-result-img">
                          {cat.image_url
                            ? <img src={optimizeImg(cat.image_url, 120)} alt="" decoding="async" loading="lazy" width={56} height={56} />
                            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 24, height: 24, padding: 16, color: 'var(--stone-400)' }}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                          }
                        </div>
                        <div>
                          <div className="search-panel-result-name">{highlightMatch(cat.name, searchInput)}</div>
                          <div className="search-panel-result-cat">Category</div>
                        </div>
                        <span className="search-panel-result-price">{cat.product_count} products</span>
                        <span className="search-panel-result-enter">&crarr;</span>
                      </div>
                    );
                  })}
                  {suggestData.collections.map(col => {
                    const idx = resultIdx++;
                    return (
                      <div key={col.name} className={'search-panel-result' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'collection', data: col })}>
                        <div className="search-panel-result-img search-panel-result-img--lg">
                          {col.image ? <img src={optimizeImg(col.image, 120)} alt="" decoding="async" loading="lazy" width={56} height={56} /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 24, height: 24, padding: 16, color: 'var(--stone-400)' }}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>}
                        </div>
                        <div>
                          <div className="search-panel-result-name">{highlightMatch(col.name, searchInput)}</div>
                          <div className="search-panel-result-cat">Collection</div>
                        </div>
                        <span className="search-panel-result-price">{col.product_count} products</span>
                        <span className="search-panel-result-enter">&crarr;</span>
                      </div>
                    );
                  })}
                  {suggestData.products.map(sku => {
                    const idx = resultIdx++;
                    const colorInfo = sku.color_family;
                    return (
                      <div key={sku.sku_id} className={'search-panel-result search-panel-result--product' + (idx === activeIdx ? ' active' : '')} onClick={() => selectSuggestion({ type: 'product', data: sku })}>
                        <div className="search-panel-result-img search-panel-result-img--lg">
                          {sku.primary_image ? <img src={optimizeImg(sku.primary_image, 120)} alt="" decoding="async" loading="lazy" width={56} height={56} /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 24, height: 24, padding: 16, color: 'var(--stone-300)' }}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>}
                        </div>
                        <div>
                          <div className="search-panel-result-name">{highlightMatch(fullProductName(sku), searchInput)}</div>
                          <div className="search-panel-result-cat">
                            {colorInfo && colorInfo.hex && <span className="search-panel-color-dot" style={{ background: colorInfo.hex }} title={colorInfo.family} />}
                            {sku.brand_name || sku.vendor_name || sku.category_name || ''}
                          </div>
                        </div>
                        <span className="search-panel-result-price">
                          {sku.sale_price && <span className="search-panel-sale-tag">SALE</span>}
                          ${displayPrice(sku, skuListPrice(sku)).toFixed(2)}{priceSuffix(sku)}
                        </span>
                        <span className="search-panel-result-enter">&crarr;</span>
                      </div>
                    );
                  })}
                  <button className="search-panel-seeall" onClick={() => { const q = searchInput.trim(); if (q) { addRecentSearch(q); } onSearch(q); onClose(); }}>
                    See all {suggestData.total || totalProducts} results &rarr;
                  </button>
                </div>
                {/* Right — suggestions & scope */}
                <div>
                  {suggestData.didYouMean && (
                    <div style={{ marginBottom: '2rem' }}>
                      <div className="search-panel-section-label">Did You Mean</div>
                      <div className="search-panel-dym-item">
                        <button onClick={() => selectSuggestion({ type: 'popular', data: { term: suggestData.didYouMean } })}>{suggestData.didYouMean}</button>
                      </div>
                    </div>
                  )}
                  <div className="search-panel-section-label">Also In</div>
                  {suggestData.categories.length > 0 && (
                    <div className="search-panel-scope-item" onClick={() => { onClose(); onSearch(searchInput); }}>
                      <span className="search-panel-scope-name">All categories</span>
                      <span className="search-panel-scope-meta">{suggestData.categories.length} matches</span>
                    </div>
                  )}
                  {suggestData.collections.length > 0 && (
                    <div className="search-panel-scope-item" onClick={() => { onClose(); onSearch(searchInput); }}>
                      <span className="search-panel-scope-name">Collections</span>
                      <span className="search-panel-scope-meta">{suggestData.collections.length} matches</span>
                    </div>
                  )}
                  <div className="search-panel-scope-item" onClick={() => { onClose(); navigate('/trade'); }}>
                    <span className="search-panel-scope-name">Trade catalog</span>
                    <span className="search-panel-scope-meta">Trade only</span>
                  </div>
                  <div className="search-panel-scope-item" onClick={() => { onClose(); navigate('/design-services'); }}>
                    <span className="search-panel-scope-name">Services</span>
                    <span className="search-panel-scope-meta">Design &amp; install</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="search-panel-footer">
            <div className="search-panel-footer-keys">
              <span><span className="search-panel-kbd">&uarr;</span><span className="search-panel-kbd">&darr;</span> Navigate</span>
              <span><span className="search-panel-kbd">&crarr;</span> Select</span>
              <span><span className="search-panel-kbd">Esc</span> Close</span>
            </div>
            <span className="search-panel-footer-action" onClick={() => { onClose(); navigate('/shop'); }}>Search 2,400+ products</span>
          </div>
        </div>
      );
    }

    function Header({ goHome, goBrowse, cart, cartDrawerOpen, setCartDrawerOpen, cartFlash, onSearch, onSkuClick, tradeCustomer, onTradeClick, onTradeLogout, customer, onAccountClick, onCustomerLogout, wishlistCount, goWishlist, goCollections, categories, onCategorySelect, globalFacets, onAxisSelect, mobileNavOpen, setMobileNavOpen, mobileSearchOpen, setMobileSearchOpen, view, navigate, goSale }) {
      const [searchInput, setSearchInput] = useState('');
      const [suggestData, setSuggestData] = useState({ categories: [], collections: [], products: [], total: 0 });
      const [showSuggestions, setShowSuggestions] = useState(false);
      const [activeIdx, setActiveIdx] = useState(-1);
      const [popularSearches, setPopularSearches] = useState([]);
      const [recentSearches, setRecentSearches] = useState(() => getRecentSearches());
      const [suggestLoading, setSuggestLoading] = useState(false);
      const [megaOpen, setMegaOpen] = useState(null);
      const [searchOpen, setSearchOpen] = useState(false);
      const suggestTimerRef = useRef(null);
      const abortRef = useRef(null);
      const preArrowInputRef = useRef(null);
      const searchWrapRef = useRef(null);
      const searchInputRef = useRef(null);
      const megaTimerRef = useRef(null);
      const itemCount = cart.length;

      // Fetch popular searches once on mount
      useEffect(() => {
        fetch(API + '/api/storefront/search/popular').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => setPopularSearches(d.terms || [])).catch(() => {});
      }, []);

      // Cmd+K / Ctrl+K global shortcut to focus search
      useEffect(() => {
        const handler = (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            if (searchInputRef.current) {
              searchInputRef.current.focus();
              setSearchOpen(true); setMegaOpen(null); clearTimeout(megaTimerRef.current);
              if (!searchInput && (popularSearches.length > 0 || recentSearches.length > 0)) setShowSuggestions(true);
            }
          }
          if (e.key === 'Escape') {
            if (searchOpen) { setSearchOpen(false); setShowSuggestions(false); if (searchInputRef.current) searchInputRef.current.blur(); }
            else if (megaOpen) { setMegaOpen(null); }
          }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
      }, [searchInput, popularSearches, recentSearches, megaOpen, searchOpen]);

      const openMegaPanel = (id) => { clearTimeout(megaTimerRef.current); setMegaOpen(id); setShowSuggestions(false); setSearchOpen(false); };
      const closeMegaPanel = () => { megaTimerRef.current = setTimeout(() => setMegaOpen(null), 140); };

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
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!controller.signal.aborted) {
              setSuggestData(data);
              setShowSuggestions(true);
              setActiveIdx(-1);
              setSuggestLoading(false);
            }
          } catch(e) { if (e.name !== 'AbortError') { setSuggestData({ categories: [], collections: [], products: [], total: 0 }); setSuggestLoading(false); } }
        }, 300);
      }, []);

      const handleSearchInput = (e) => { preArrowInputRef.current = null; setActiveIdx(-1); setSearchInput(e.target.value); fetchSuggestions(e.target.value); };
      const selectSuggestion = (item) => {
        setShowSuggestions(false); setSearchOpen(false); setSearchInput(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 });
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
        if ((!showSuggestions && !searchOpen) || totalItems === 0) {
          if (e.key === 'Escape' && searchOpen) { setSearchOpen(false); setShowSuggestions(false); }
          return;
        }
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
        else if (e.key === 'Escape') { setShowSuggestions(false); setSearchOpen(false); if (preArrowInputRef.current !== null) { setSearchInput(preArrowInputRef.current); preArrowInputRef.current = null; } }
      };

      useEffect(() => {
        const handleClickOutside = (e) => {
          if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
            // If click is inside the search panel, don't close
            const panel = e.target.closest('.search-panel');
            if (!panel) { setShowSuggestions(false); setSearchOpen(false); }
          }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }, []);

      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);

      // Build dynamic shop columns from categories (children are nested in API response)
      const shopColumns = useMemo(() => {
        const cols = [];
        parentCats.forEach(cat => {
          const children = (cat.children || [])
            .filter(ch => ch.product_count > 0)
            .sort((a, b) => b.product_count - a.product_count);
          const items = children.slice(0, 8).map(ch => ({ name: ch.name, slug: ch.slug, count: ch.product_count || 0 }));
          items.push({ name: 'View All', slug: cat.slug, count: cat.product_count || 0, isViewAll: true });
          cols.push({ title: cat.name, items });
        });
        return cols;
      }, [parentCats, categories]);

      const hasSuggestResults = suggestData.categories.length > 0 || suggestData.collections.length > 0 || suggestData.products.length > 0;
      let suggestItemIdx = 0;

      const searchForm = (
        <form className="header-search" ref={searchWrapRef} onSubmit={(e) => { e.preventDefault(); const q = searchInput.trim(); if (q) { addRecentSearch(q); setRecentSearches(getRecentSearches()); onSearch(q); setShowSuggestions(false); setSearchOpen(false); setSearchInput(''); } }}>
          <button type="submit" className="header-search-icon" tabIndex={-1} aria-label="Search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <input ref={searchInputRef} type="text" placeholder="Search products..." value={searchInput} autoComplete="off" onChange={handleSearchInput} onKeyDown={handleSearchKeyDown} onFocus={() => {
            setMegaOpen(null); clearTimeout(megaTimerRef.current);
            setSearchOpen(true);
            if (hasSuggestResults || (!searchInput && (popularSearches.length > 0 || recentSearches.length > 0))) setShowSuggestions(true);
          }} />
          {searchInput && (
            <button type="button" className="header-search-clear" onClick={() => { setSearchInput(''); setSuggestData({ categories: [], collections: [], products: [], total: 0 }); setShowSuggestions(false); }} aria-label="Clear search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
          {!searchInput && !searchOpen && (
            <span className="header-search-kbd">{navigator.platform.indexOf('Mac') > -1 ? '⌘K' : 'Ctrl+K'}</span>
          )}
        </form>
      );

      const NAV_ITEMS = [
        { id: 'shop', label: 'Shop', hasPanel: true, onClick: () => goBrowse() },
        { id: 'services', label: 'Services', hasPanel: true, onClick: () => navigate('/design-services') },
        { id: 'materials', label: 'Materials', hasPanel: true, onClick: () => goBrowse() },
        { id: 'trade', label: 'Trade', hasPanel: true, onClick: () => onTradeClick() },
        { id: 'about', label: 'About', hasPanel: false, onClick: () => navigate('/about') },
      ];

      return (<>
        <header onMouseLeave={() => setMegaOpen(null)}>
          {/* Row 1 — Warm Utility Strip */}
          <div className="utility-bar">
            <div className="utility-bar-inner">
              <div className="utility-bar-left">
                <span>1440 S. State College Blvd Suite 6M</span>
                <span className="utility-bar-dot">&bull;</span>
                <span>Anaheim, CA</span>
                <span className="utility-bar-dot">&bull;</span>
                <span>Mon&ndash;Fri 9&ndash;5 &middot; Sat 10&ndash;5</span>
              </div>
              <div className="utility-bar-right">
                <a href="tel:+17149990009" className="utility-bar-phone">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                  (714) 999-0009
                </a>
              </div>
            </div>
          </div>

          {/* Row 2 — Main Bar (grid: logo | nav | actions) */}
          <div className="header-main">
            <div className="header-main-left">
              <button className="mobile-menu-btn" aria-label="Open navigation menu" onClick={() => setMobileNavOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <div className="logo" onClick={goHome}>
                <span className="logo-text">R O M A <em>Flooring</em></span>
              </div>
            </div>

            <nav className="header-nav">
              {NAV_ITEMS.map(item => (
                <button
                  key={item.id}
                  className={'header-nav-btn' + (megaOpen === item.id ? ' active' : '')}
                  onMouseEnter={() => { if (item.hasPanel) openMegaPanel(item.id); else { setMegaOpen(null); setSearchOpen(false); setShowSuggestions(false); } }}
                  onClick={() => { setMegaOpen(null); setSearchOpen(false); setShowSuggestions(false); item.onClick(); }}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div className="header-main-right">
              <button className="mobile-search-btn" aria-label="Search products" onClick={() => setMobileSearchOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              {searchForm}
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

          {megaOpen && (
            <MegaPanel
              panelId={megaOpen}
              categories={categories}
              onCategorySelect={(slug) => { setMegaOpen(null); onCategorySelect(slug); }}
              onTradeClick={() => { setMegaOpen(null); onTradeClick(); }}
              navigate={(path) => { setMegaOpen(null); navigate(path); }}
              shopColumns={shopColumns}
              onEnter={() => clearTimeout(megaTimerRef.current)}
              onClose={closeMegaPanel}
            />
          )}

          {searchOpen && !megaOpen && (
            <SearchPanel
              searchInput={searchInput}
              parentCats={parentCats}
              suggestData={suggestData}
              suggestLoading={suggestLoading}
              popularSearches={popularSearches}
              recentSearches={recentSearches}
              activeIdx={activeIdx}
              onSearch={(q) => { setSearchOpen(false); setShowSuggestions(false); setSearchInput(''); onSearch(q); }}
              onCategorySelect={onCategorySelect}
              onSkuClick={onSkuClick}
              onClose={() => { setSearchOpen(false); setShowSuggestions(false); }}
              selectSuggestion={selectSuggestion}
              tradeCustomer={tradeCustomer}
              hasSuggestResults={hasSuggestResults}
              suggestItems={suggestItems}
              navigate={(path) => { setSearchOpen(false); setShowSuggestions(false); navigate(path); }}
            />
          )}

        </header>
        <div className={'mega-menu-scrim' + ((megaOpen || searchOpen) ? ' visible' : '')} onClick={() => { setMegaOpen(null); setSearchOpen(false); setShowSuggestions(false); }} />
      </>
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
                        {item.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image, 100)} alt="" decoding="async" loading="lazy" width={40} height={40} />}
                      </div>
                      <div className="cart-drawer-item-info">
                        <div className="cart-drawer-item-name">
                          {fullProductName(item) || 'Product'}
                          {item.is_sample && <span className="sample-tag">Sample</span>}
                        </div>
                        <div className="cart-drawer-item-meta">
                          {item.is_sample ? 'FREE SAMPLE' : item.sell_by === 'unit' ? `Qty: ${item.num_boxes}` : item.sell_by === 'sqft' ? `${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft` : `${item.price_tier ? '' : item.num_boxes + ' box' + (parseInt(item.num_boxes) !== 1 ? 'es' : '') + ' · '}${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft`}
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
      const [fetchError, setFetchError] = useState(false);
      const [adding, setAdding] = useState(false);
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
        const colorSiblings = (data.same_product_siblings || []).filter(s => s.variant_type !== 'accessory')
          .sort((a, b) => (a.variant_name || '').localeCompare(b.variant_name || ''));
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
        setFetchError(false);
        fetch('/api/storefront/skus/' + initialSku.sku_id, { headers: getTradeHeaders() })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { if (!cancelled) applyDetail(data); })
          .catch(err => { console.error('QuickView fetch error:', err); if (!cancelled) setFetchError(true); })
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [initialSku.sku_id]);

      // Keyboard: Escape to close, arrows to slide
      useEffect(() => {
        const handleKey = (e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowLeft') setImgIndex(i => Math.max(0, i - 1));
          else if (e.key === 'ArrowRight') setImgIndex(i => media.length > 0 ? Math.min(i + 1, media.length - 1) : 0);
        };
        document.addEventListener('keydown', handleKey);
        document.body.style.overflow = 'hidden';
        return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
      }, [media.length]);

      const qvIsOutOfStock = activeSku.stock_status === 'out_of_stock' && activeSku.vendor_has_inventory !== false;

      const handleAdd = () => {
        if (adding || qvIsOutOfStock) return;
        setAdding(true);
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
        setActiveSku(prev => ({ ...prev, sku_id: sib.sku_id, variant_name: sib.variant_name, retail_price: sib.retail_price, cut_price: sib.cut_price, primary_image: sib.primary_image, sell_by: sib.sell_by, price_basis: sib.price_basis, sqft_per_box: sib.sqft_per_box }));
        fetch('/api/storefront/skus/' + sib.sku_id, { headers: getTradeHeaders() })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => applyDetail(data));
      };

      const currentImg = media[imgIndex] || {};
      const catName = activeSku.category_name || '';
      const vendorLabel = activeSku.brand_name || activeSku.vendor_name || '';
      const effectivePrice = displayPrice(activeSku, activeSku.trade_price || activeSku.sale_price || skuListPrice(activeSku) || 0);
      const sqftBox = parseFloat(activeSku.sqft_per_box) || 0;
      const boxPrice = sqftBox > 0 && !isUnit ? (effectivePrice * sqftBox) : 0;
      const allSwatches = siblings.length > 0 ? [
        { sku_id: activeSku.sku_id, variant_name: activeSku.variant_name, primary_image: (baseMediaRef.current[0] || {}).url, _isCurrent: true },
        ...siblings.filter(s => s.sku_id !== activeSku.sku_id)
      ].sort((a, b) => (a.variant_name || '').localeCompare(b.variant_name || '')) : [];

      // Build compact specs from attributes
      const specItems = [];
      const specKeys = ['species', 'width', 'finish', 'material'];
      (activeSku.attributes || []).forEach(attr => {
        if (specKeys.includes(attr.slug) && attr.value) specItems.push({ label: attr.name || attr.slug, value: attr.value });
      });
      if (specItems.length < 4 && catName) specItems.push({ label: 'Category', value: catName });

      return (
        <div className="quick-view-overlay" onClick={onClose}>
          <div className="quick-view" onClick={e => e.stopPropagation()}>
            <button className="quick-view-close" onClick={onClose} aria-label="Close">&times;</button>
            {fetchError ? (
              <div className="qv-error-state">
                <p className="qv-error-text">Unable to load product details.</p>
                <button className="btn btn-outline" onClick={onClose}>Close</button>
              </div>
            ) : <>
            <div className="quick-view-gallery">
              <div className="quick-view-main-image">
                {media.length > 1 && (
                  <button className="quick-view-gallery-arrow left" disabled={imgIndex === 0} onClick={() => setImgIndex(i => i - 1)}>{'\u2039'}</button>
                )}
                {currentImg.url && <img onLoad={handleProductImgLoad} src={optimizeImg(currentImg.url, 800)} {...optimizeSrcSet(currentImg.url, [400, 600, 800])} sizes="(max-width: 768px) 90vw, 540px" alt={activeSku.product_name} decoding="async" width={540} height={540} />}
                {media.length > 1 && (
                  <button className="quick-view-gallery-arrow right" disabled={imgIndex >= media.length - 1} onClick={() => setImgIndex(i => i + 1)}>{'\u203A'}</button>
                )}
                {media.length > 1 && (
                  <div className="quick-view-img-counter">{String(imgIndex + 1).padStart(2, '0')} / {String(media.length).padStart(2, '0')}</div>
                )}
              </div>
              {media.length > 1 && (
                <div className="quick-view-thumbstrip">
                  {media.map((m, i) => (
                    <div key={i} className={'quick-view-thumb' + (i === imgIndex ? ' active' : '')} onClick={() => setImgIndex(i)}>
                      {m.url && <img onLoad={handleProductImgLoad} src={optimizeImg(m.url, 160)} alt={''} decoding="async" width={80} height={72} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="quick-view-info">
              <div className="qv-eyebrow">
                <span className="qv-eyebrow-cat">{catName}{vendorLabel ? ' \u00B7 ' + vendorLabel : ''}</span>
                <span className="qv-eyebrow-stock">{isUnit ? 'Accessory' : 'Flooring'}</span>
              </div>
              <h2>{fullProductName(activeSku)}</h2>
              {activeSku.variant_name && (
                <div className="qv-variant-label">{formatVariantName(activeSku.variant_name)}{activeSku.sku_code ? ' \u00B7 SKU ' + activeSku.sku_code : ''}</div>
              )}

              {/* Compact specs grid */}
              {specItems.length > 0 && (
                <div className="qv-specs-grid">
                  {specItems.slice(0, 4).map((sp, i) => (
                    <div key={i} className="qv-spec-item">
                      <div className="qv-spec-label">{sp.label}</div>
                      <div className="qv-spec-value">{sp.value}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="qv-price-block">
                <div>
                  <div className="qv-price-amount">
                    {(activeSku.trade_price && skuListPrice(activeSku)) && (
                      <span className="qv-price-original">${displayPrice(activeSku, skuListPrice(activeSku)).toFixed(2)}</span>
                    )}
                    {(!activeSku.trade_price && activeSku.sale_price && skuListPrice(activeSku)) && (
                      <span className="qv-price-original">${displayPrice(activeSku, skuListPrice(activeSku)).toFixed(2)}</span>
                    )}
                    ${effectivePrice.toFixed(2)}
                    <span className="qv-price-suffix">{priceSuffix(activeSku)}</span>
                    {!activeSku.trade_price && activeSku.sale_price && parseFloat(skuListPrice(activeSku)) > 0 && (
                      <span className="qv-sale-tag">{Math.round((1 - parseFloat(activeSku.sale_price) / parseFloat(skuListPrice(activeSku))) * 100)}% off</span>
                    )}
                  </div>
                  {activeSku.trade_price && (
                    <div className="qv-price-note">Trade pricing applied</div>
                  )}
                </div>
                {sqftBox > 0 && !isUnit && (
                  <div className="qv-price-right">
                    Boxed at <strong>{sqftBox.toFixed(1)} sf</strong><br/>
                    <span className="qv-box-price">${boxPrice.toFixed(2)} / box</span>
                  </div>
                )}
              </div>

              {allSwatches.length > 0 && (
                <div>
                  <div className="quick-view-variants-header">
                    <span>Colorway &middot; {allSwatches.length} options</span>
                    <span className="qv-current-variant">{formatVariantName(activeSku.variant_name)}</span>
                  </div>
                  <div className="quick-view-variants">
                    {allSwatches.map(sib => (
                      <div
                        key={sib.sku_id}
                        className={'quick-view-variant-swatch' + (sib._isCurrent ? ' active' : '')}
                        title={formatVariantName(sib.variant_name)}
                        onMouseEnter={() => !sib._isCurrent && handleVariantHover(sib)}
                        onMouseLeave={() => !sib._isCurrent && handleVariantLeave()}
                        onClick={() => !sib._isCurrent && handleVariantClick(sib)}
                      >
                        {sib.primary_image ? <img onLoad={handleProductImgLoad} src={optimizeImg(sib.primary_image, 120)} alt={sib.variant_name} decoding="async" width={44} height={44} /> : <div className="qv-swatch-placeholder">{formatVariantName(sib.variant_name)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeSku.description_short && (
                <p className="qv-description">{activeSku.description_short}</p>
              )}

              {activeSku.stock_status && activeSku.stock_status !== 'unknown' && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <StockBadge status={activeSku.stock_status} vendorHasInventory={activeSku.vendor_has_inventory} qtyOnHand={activeSku.qty_on_hand} qtyOnHandSqft={activeSku.qty_on_hand_sqft} sellBy={activeSku.sell_by} />
                </div>
              )}

              {isUnit ? (
                <div className="quick-view-actions">
                  {!qvIsOutOfStock && (
                    <div className="qv-qty-stepper">
                      <button onClick={() => setQty(q => Math.max(1, q - 1))}>&minus;</button>
                      <div className="qv-qty-display">{qty}</div>
                      <button onClick={() => setQty(q => q + 1)}>+</button>
                    </div>
                  )}
                  <button className="qv-btn-primary" onClick={qvIsOutOfStock ? undefined : handleAdd} disabled={qvIsOutOfStock}>
                    {qvIsOutOfStock ? 'Out of Stock' : ('Add to cart' + (qty > 1 ? ' \u00B7 $' + (effectivePrice * qty).toFixed(2) : ''))}
                  </button>
                  <button className="qv-btn-secondary" onClick={() => { onViewDetail(activeSku.sku_id, activeSku.product_name); onClose(); }}>Order sample</button>
                </div>
              ) : (
                <div className="quick-view-actions qv-sqft-actions">
                  <button className="qv-btn-primary" onClick={() => { onViewDetail(activeSku.sku_id, activeSku.product_name); onClose(); }}>Calculate coverage</button>
                  <button className="qv-btn-secondary" onClick={() => { onViewDetail(activeSku.sku_id, activeSku.product_name); onClose(); }}>Order sample</button>
                </div>
              )}

              <div className="qv-footer">
                <div className="qv-footer-links">
                  <button className="qv-footer-link" onClick={() => { if (typeof toggleWishlist === 'function') toggleWishlist(activeSku.sku_id); }} title="Save to wishlist">
                    <span className="qv-link-icon">{'\u2661'}</span> Save
                  </button>
                </div>
                <button className="qv-detail-link" onClick={() => { onViewDetail(activeSku.sku_id, activeSku.product_name); onClose(); }}>View full details &rarr;</button>
              </div>
            </div>
            </>}
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
              <a href="#" onClick={e => { e.preventDefault(); goHome(); onClose(); }}>Home</a>
              <a href="#" onClick={e => { e.preventDefault(); goBrowse(); onClose(); }}>Shop All</a>
              {parentCats.map(cat => {
                const children = categories.filter(c => c.parent_id === cat.id);
                if (children.length === 0) {
                  return <a key={cat.id} href="#" onClick={e => { e.preventDefault(); onCategorySelect(cat.slug); onClose(); }}>{cat.name}</a>;
                }
                return (
                  <div key={cat.id} className="mobile-nav-cat-item">
                    <div className="mobile-nav-cat-header" onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}>
                      <span>{cat.name}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, transform: expandedCat === cat.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    {expandedCat === cat.id && (
                      <div className="mobile-nav-cat-children">
                        <a href="#" onClick={e => { e.preventDefault(); onCategorySelect(cat.slug); onClose(); }}>All {cat.name}</a>
                        {children.map(child => (
                          <a key={child.id} href="#" onClick={e => { e.preventDefault(); onCategorySelect(child.slug); onClose(); }}>{child.name}</a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <a href="#" onClick={e => { e.preventDefault(); goCollections(); onClose(); }}>Collections</a>
            </div>
            {!tradeCustomer && (
              <a className="mobile-nav-trade-cta" href="#" onClick={e => { e.preventDefault(); onTradeClick(); onClose(); }}>Trade Program</a>
            )}
            <div className="mobile-nav-footer">
              {customer ? (
                <div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>Signed in as {customer.first_name || customer.email}</div>
                  <a href="#" onClick={e => { e.preventDefault(); goAccount(); onClose(); }}>My Account</a>
                  <a href="#" onClick={e => { e.preventDefault(); onCustomerLogout(); onClose(); }}>Sign Out</a>
                </div>
              ) : tradeCustomer ? (
                <div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>Trade: {tradeCustomer.company_name}</div>
                  <a href="#" onClick={e => { e.preventDefault(); goTrade(); onClose(); }}>Trade Dashboard</a>
                  <a href="#" onClick={e => { e.preventDefault(); onTradeLogout(); onClose(); }}>Sign Out</a>
                </div>
              ) : (
                <div>
                  <a href="#" onClick={e => { e.preventDefault(); goAccount(); onClose(); }}>Sign In</a>
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
          fetch(API + '/api/storefront/search/popular').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => setMobilePopular(d.terms || [])).catch(() => {});
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
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            setSuggestData(data);
          } catch(e) { setSuggestData({ categories: [], collections: [], products: [], total: 0 }); }
          setLoading(false);
        }, 250);
        return () => clearTimeout(debounceRef.current);
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
          {!hasResults && !loading && query && query.length >= 2 && (suggestData.didYouMean || suggestData.autoCorrect) && (
            <div className="mobile-search-results">
              <div className="search-suggest-section">
                {suggestData.autoCorrect ? (
                  <div className="search-autocorrect-banner">
                    Showing results for <strong>{suggestData.autoCorrect.correctedQuery}</strong>.{' '}
                    <button className="search-autocorrect-link" onClick={() => setQuery(query)}>Search instead for &ldquo;{query}&rdquo;</button>
                  </div>
                ) : (
                  <div className="search-did-you-mean" onClick={() => { setQuery(suggestData.didYouMean); }}>
                    Did you mean: <strong>{suggestData.didYouMean}</strong>?
                  </div>
                )}
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
                        {cat.image_url
                          ? <img src={optimizeImg(cat.image_url, 80)} alt="" decoding="async" loading="lazy" width={32} height={32} style={{ borderRadius: 3, objectFit: 'cover' }} />
                          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                        }
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
                      {col.image ? <img className="search-suggest-collection-img" onLoad={handleProductImgLoad} src={optimizeImg(col.image, 100)} alt="" decoding="async" loading="lazy" width={48} height={48} /> : <span className="search-suggest-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></span>}
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
                  {suggestData.products.map(sku => {
                    const colorInfo = sku.color_family;
                    return (
                      <div key={sku.sku_id} className="mobile-search-result" onClick={() => { addRecentSearch(sku.product_name || sku.collection); onSkuClick(sku.sku_id, sku.product_name); onClose(); }}>
                        <div className="mobile-search-result-img mobile-search-result-img--lg">
                          {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 120)} alt="" decoding="async" loading="lazy" width={56} height={56} />}
                        </div>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>{highlightMatch(fullProductName(sku), query)}</div>
                          <div className="search-suggestion-vendor">
                            {colorInfo && colorInfo.hex && <span className="search-panel-color-dot" style={{ background: colorInfo.hex }} title={colorInfo.family} />}
                            {sku.brand_name || sku.vendor_name || ''}
                          </div>
                          <div style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>
                            {sku.sale_price && <span className="search-panel-sale-tag">SALE</span>}
                            ${displayPrice(sku, skuListPrice(sku)).toFixed(2)}{priceSuffix(sku)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="skeleton-search-result" style={{ animationDelay: (i * 0.1) + 's' }}>
                  <div className="skeleton-search-img" style={{ width: 56, height: 56 }} />
                  <div className="skeleton-search-lines">
                    <div className="skeleton-bar skeleton-bar-short" style={{ marginTop: 0 }} />
                    <div className="skeleton-bar skeleton-bar-medium" />
                  </div>
                  <div className="skeleton-bar" style={{ width: 40, height: 10 }} />
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
                {cat.image_url && <img onLoad={handleProductImgLoad} src={optimizeImg(cat.image_url, 400)} alt={cat.name} loading="lazy" decoding="async" />}
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

    function HomePage({ featuredSkus, featuredLoading, categories, onSkuClick, onCategorySelect, goBrowse, goTrade, goCabinets, navigate, wishlist, toggleWishlist, setQuickViewSku, newsletterEmail, setNewsletterEmail, newsletterSubmitted, onNewsletterSubmit, onOpenQuiz }) {
      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);
      const cabinetImages = parentCats.slice(0, 3).map(c => c.image_url).filter(Boolean);
      const specimens = featuredSkus.slice(0, 3);

      return (
        <>
          {/* Hero */}
          <section className="form-hero">
            <div className="form-hero-inner">
              <div className="form-eyebrow">Flooring &amp; Surfaces &middot; Anaheim, est. 1999</div>
              <h1 className="form-hero-headline">Premium surfaces for the spaces that shape how you live</h1>
              <button className="form-hero-cta" onClick={goBrowse}>Browse the catalog</button>
            </div>
          </section>

          {/* Cabinet Feature Band */}
          <RevealSection>
            <section className="form-cabinet-band">
              <div className="form-cabinet-inner">
                <div className="form-cabinet-images">
                  <img src={optimizeImg('/uploads/homepage/cabinet-1.jpg', 500)} alt="Maple Cider and Painted Sage kitchen" loading="lazy" decoding="async" />
                  <img src={optimizeImg('/uploads/homepage/cabinet-2.jpg', 500)} alt="Navy island with Maple Cider uppers" loading="lazy" decoding="async" />
                  <img src={optimizeImg('/uploads/homepage/cabinet-3.jpg', 500)} alt="Maple Cider and Painted Vanilla kitchen" loading="lazy" decoding="async" />
                </div>
                <div className="form-cabinet-content">
                  <div className="form-eyebrow">Custom Cabinetry</div>
                  <h2 className="form-cabinet-headline">Cabinets, built to <em>the room</em></h2>
                  <p className="form-cabinet-body">Every kitchen and bath is different. Our cabinetry program pairs premium materials with made-to-measure construction so nothing is compromised.</p>
                  <div className="form-cabinet-stats">
                    <div className="form-cabinet-stat">
                      <div className="form-cabinet-stat-value">4</div>
                      <div className="form-cabinet-stat-label">Brands</div>
                    </div>
                    <div className="form-cabinet-stat">
                      <div className="form-cabinet-stat-value">86</div>
                      <div className="form-cabinet-stat-label">Door styles</div>
                    </div>
                    <div className="form-cabinet-stat">
                      <div className="form-cabinet-stat-value">140+</div>
                      <div className="form-cabinet-stat-label">Colors</div>
                    </div>
                  </div>
                  <button className="form-cabinet-link" onClick={goCabinets}>Explore cabinetry &rarr;</button>
                </div>
              </div>
            </section>
          </RevealSection>

          {/* Featured This Season */}
          <RevealSection delay={0.1}>
            <section className="form-section">
              <div className="form-section-header">
                <div className="form-eyebrow">Featured This Season</div>
                <h2 className="form-section-headline">Selected specimens</h2>
              </div>
              {featuredLoading ? (
                <SkeletonGrid count={3} />
              ) : specimens.length > 0 ? (
                <div className="form-specimen-grid">
                  {specimens.map((sku, i) => {
                    const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
                    const price = sku.trade_price || sku.sale_price || basePrice;
                    return (
                      <div key={sku.sku_id} className="form-specimen-card" onClick={() => onSkuClick(sku.sku_id, sku.product_name)}>
                        <div className="form-specimen-card-image">
                          {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 600)} alt={sku.product_name} loading="lazy" decoding="async" />}
                        </div>
                        <div className="form-specimen-card-meta">No. {String(i + 1).padStart(2, '0')} &middot; {sku.category_name || 'Flooring'}</div>
                        {price && <div className="form-specimen-card-price">${displayPrice(sku, price).toFixed(2)}{priceSuffix(sku)}</div>}
                        <div className="form-specimen-card-name">{fullProductName(sku)}</div>
                        <div className="form-specimen-card-desc">{sku.brand_name || sku.vendor_name}{sku.variant_name ? ' \u00B7 ' + sku.variant_name : ''}</div>
                        <div className="form-specimen-card-cta">View in catalog &rarr;</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="featured-empty">Featured products coming soon.</p>
              )}
            </section>
          </RevealSection>

          {/* Counsel Band */}
          <RevealSection delay={0.1}>
            <section className="form-counsel-band">
              <div className="form-counsel-inner">
                <h2 className="form-counsel-headline">We send free samples anywhere in the country</h2>
                <p className="form-counsel-body">Choose up to five materials and we will ship them to your door at no cost. Touch the grain, see the color in your own light, then decide.</p>
                <div className="form-counsel-actions">
                  <button className="form-counsel-btn form-counsel-btn-light" onClick={goBrowse}>Build a sample box</button>
                  <button className="form-counsel-btn form-counsel-btn-outline" onClick={() => navigate('/about')}>Visit the showroom</button>
                </div>
              </div>
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

    // ==================== Shop Landing ====================

    function ShopLanding({ categories, featuredSkus, featuredLoading, onCategorySelect, onSkuClick, goTrade, navigate }) {
      const parentCats = categories.filter(c => !c.parent_id && c.product_count > 0);
      const heroCats = parentCats.slice(0, 2);
      const gridCats = parentCats.slice(2, 6);
      const totalProducts = categories.reduce((s, c) => s + (c.product_count || 0), 0);
      const featured = featuredSkus.slice(0, 6);

      return (
        <>
          {/* Shop Hero */}
          <section className="shop-landing-hero">
            <div className="shop-landing-hero-inner">
              <div className="shop-landing-hero-left">
                <div className="form-eyebrow">Roma Flooring Designs</div>
                <h1 className="shop-landing-hero-headline">The catalog.</h1>
              </div>
              <div className="shop-landing-hero-right">
                <p className="shop-landing-hero-intro">Every surface we carry has been tested, graded, and selected by our materials team. Browse by category, compare specimens side by side, and order samples shipped free.</p>
                <div className="shop-landing-hero-actions">
                  <button className="shop-landing-hero-btn" onClick={() => navigate('/shop?category=tile')}>Order samples</button>
                  <button className="shop-landing-hero-link" onClick={() => navigate('/about')}>Book a showroom visit</button>
                </div>
                <div className="shop-landing-stat"><strong>{totalProducts.toLocaleString()}</strong> products across <strong>{parentCats.length}</strong> categories</div>
              </div>
            </div>
          </section>

          {/* Section 01 — Category Mosaic */}
          {parentCats.length > 0 && (
            <RevealSection>
              <section className="shop-landing-section">
                <div className="shop-landing-section-header">
                  <span className="shop-landing-section-num">01</span>
                  <h2 className="shop-landing-section-title">Shop by material</h2>
                </div>
                <div className="shop-cat-mosaic">
                  <div className="shop-cat-heroes">
                    {heroCats.map(cat => (
                      <div key={cat.slug} className="shop-cat-card shop-cat-card-hero" onClick={() => onCategorySelect(cat.slug)}>
                        {cat.image_url && <img src={optimizeImg(cat.image_url, 600)} alt={cat.name} loading="lazy" decoding="async" />}
                        <div className="shop-cat-card-overlay">
                          <div className="shop-cat-card-count">{cat.product_count} products</div>
                          <div className="shop-cat-card-name">{cat.name}</div>
                          <div className="shop-cat-card-cta">Browse &rarr;</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="shop-cat-grid-right">
                    {gridCats.map(cat => (
                      <div key={cat.slug} className="shop-cat-card shop-cat-card-std" onClick={() => onCategorySelect(cat.slug)}>
                        {cat.image_url && <img src={optimizeImg(cat.image_url, 400)} alt={cat.name} loading="lazy" decoding="async" />}
                        <div className="shop-cat-card-overlay">
                          <div className="shop-cat-card-count">{cat.product_count} products</div>
                          <div className="shop-cat-card-name">{cat.name}</div>
                          <div className="shop-cat-card-cta">Browse &rarr;</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </RevealSection>
          )}

          {/* Section 02 — Featured Grid */}
          <RevealSection delay={0.1}>
            <section className="shop-landing-section">
              <div className="shop-landing-section-header">
                <span className="shop-landing-section-num">02</span>
                <h2 className="shop-landing-section-title">Featured specimens</h2>
              </div>
              {featuredLoading ? (
                <SkeletonGrid count={6} />
              ) : featured.length > 0 ? (
                <div className="shop-featured-grid">
                  {featured.map(sku => {
                    const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
                    const price = sku.trade_price || sku.sale_price || basePrice;
                    return (
                      <div key={sku.sku_id} className="shop-featured-card" onClick={() => onSkuClick(sku.sku_id, sku.product_name)}>
                        <div className="shop-featured-card-image">
                          {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 500)} alt={sku.product_name} loading="lazy" decoding="async" />}
                        </div>
                        <div className="shop-featured-card-cat">{sku.category_name || 'Flooring'}</div>
                        <div className="shop-featured-card-name">{fullProductName(sku)}</div>
                        <div className="shop-featured-card-meta">{sku.brand_name || sku.vendor_name}{sku.variant_name ? ' \u00B7 ' + sku.variant_name : ''}</div>
                        <div className="shop-featured-card-bottom">
                          <span className="shop-featured-card-price">{price ? '$' + displayPrice(sku, price).toFixed(2) + priceSuffix(sku) : 'Call for price'}</span>
                          <span className="shop-featured-card-cta">View &rarr;</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="featured-empty">Featured products coming soon.</p>
              )}
            </section>
          </RevealSection>

          {/* Section 03 — Trade Band */}
          <RevealSection delay={0.1}>
            <section className="shop-trade-band">
              <div className="shop-trade-inner">
                <h2 className="shop-trade-headline">Built for the trade</h2>
                <p className="shop-trade-body">Contractors, designers, and architects get exclusive pricing, dedicated account management, and tools built for commercial projects.</p>
                <div className="shop-trade-benefits">
                  <div className="shop-trade-benefit">
                    <div className="shop-trade-benefit-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/><circle cx="12" cy="12" r="5"/></svg>
                    </div>
                    <div className="shop-trade-benefit-label">Tiered pricing</div>
                  </div>
                  <div className="shop-trade-benefit">
                    <div className="shop-trade-benefit-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="3" width="15" height="13" rx="1"/><polyline points="16 8 20 8 23 11 23 16 20 16"/><circle cx="18" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
                    </div>
                    <div className="shop-trade-benefit-label">Free shipping</div>
                  </div>
                  <div className="shop-trade-benefit">
                    <div className="shop-trade-benefit-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                    </div>
                    <div className="shop-trade-benefit-label">Dedicated rep</div>
                  </div>
                  <div className="shop-trade-benefit">
                    <div className="shop-trade-benefit-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a4 4 0 00-8 0v2"/></svg>
                    </div>
                    <div className="shop-trade-benefit-label">Bulk samples</div>
                  </div>
                </div>
                <button className="shop-trade-cta" onClick={goTrade}>Apply for trade access</button>
              </div>
            </section>
          </RevealSection>
        </>
      );
    }

    // ==================== Category Hero ====================

    function CategoryHero({ category, crumbs, searchQuery, totalSkus, vendorCount }) {
      if (searchQuery) {
        return (
          <div className="category-header-editorial category-header-search">
            <div className="cat-header-top">
              <div className="cat-header-breadcrumb">
                {crumbs.map((c, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="cat-crumb-sep" />}
                    {c.onClick
                      ? <a onClick={c.onClick}>{c.label}</a>
                      : <span className="cat-crumb-current">{c.label}</span>
                    }
                  </React.Fragment>
                ))}
              </div>
              <div className="cat-header-stats">
                {totalSkus} result{totalSkus !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="cat-header-body cat-header-body-search">
              <div>
                <h1 className="cat-header-headline">
                  {totalSkus} results for {'\u2018'}<em>{searchQuery}</em>{'\u2019'}
                </h1>
              </div>
            </div>
          </div>
        );
      }

      const catName = category ? category.name : 'Shop All';
      const children = category && category.children ? category.children : [];
      const isParent = children.length > 0 && category && !category.parent_id;

      // Build kicker text: for parent categories, show child names + product count
      let kickerText = category ? `Material · ${catName}` : null;
      if (isParent && children.length > 0) {
        const childNames = children.map(ch => ch.name).join(' & ').toUpperCase();
        kickerText = `Material · ${childNames} · ${totalSkus} Products`;
      }

      return (
        <div className="category-header-editorial">
          <div className="cat-header-top">
            <div className="cat-header-breadcrumb">
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="cat-crumb-sep" />}
                  {c.onClick
                    ? <a onClick={c.onClick}>{c.label}</a>
                    : <span className="cat-crumb-current">{c.label}</span>
                  }
                </React.Fragment>
              ))}
            </div>
            <div className="cat-header-stats">
              {totalSkus} product{totalSkus !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="cat-header-body">
            <div>
              {kickerText && <div className="cat-header-kicker">
                {kickerText}
              </div>}
              <h1 className="cat-header-headline">{catName}</h1>
            </div>
            <div className="cat-header-right">
              {category && category.description && (
                <p className="cat-header-intro">{category.description}</p>
              )}
              {isParent && (
                <div className="cat-header-facts">
                  <div className="cat-fact">
                    <div className="cat-fact-value">{vendorCount || 0}</div>
                    <div className="cat-fact-label">Brands</div>
                  </div>
                  <div className="cat-fact">
                    <div className="cat-fact-value">{totalSkus}</div>
                    <div className="cat-fact-label">Products</div>
                  </div>
                  <div className="cat-fact">
                    <div className="cat-fact-value">{children.length}</div>
                    <div className="cat-fact-label">Sub-categories</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // ==================== Browse View ====================

    function BrowseView({ skus, totalSkus, loading, categories, selectedCategory, selectedCollection, searchQuery, onCategorySelect, onSearch, facets, filters, onFilterToggle, onBatchFilterSet, onClearFilters, sortBy, onSortChange, onSkuClick, currentPage, onPageChange, wishlist, toggleWishlist, setQuickViewSku, filterDrawerOpen, setFilterDrawerOpen, goHome,
      vendorFacets, vendorFilters, onVendorToggle, priceRange, userPriceRange, onPriceRangeChange, tagFacets, tagFilters, onTagToggle, didYouMean, searchTimeMs, relatedSearches, matchingCategories }) {
      const [viewMode, setViewMode] = useState('grid');
      const totalPages = Math.ceil(totalSkus / 24);
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
        facets, filters, onFilterToggle, onBatchFilterSet, onClearFilters,
        vendors: vendorFacets, vendorFilters, onVendorToggle,
        priceRange, userPriceRange, onPriceRangeChange,
        tagFacets, tagFilters, onTagToggle, totalSkus
      };

      // Check if this is a parent category with subcategories → show landing page
      const isParentLanding = currentCategory && !currentCategory.parent_id && !searchQuery && !selectedCollection;
      const landingChildren = isParentLanding
        ? (currentCategory.children || []).filter(ch => ch.product_count > 0)
        : [];

      return (
        <>
          <CategoryHero category={currentCategory} crumbs={crumbs} searchQuery={searchQuery} totalSkus={totalSkus} vendorCount={vendorFacets ? vendorFacets.length : 0} />
          {isParentLanding && landingChildren.length > 0 && (
            <div className="subcategory-strip">
              <div className="subcategory-strip-grid" style={{ gridTemplateColumns: 'repeat(' + Math.min(landingChildren.length, 6) + ', 1fr)' }}>
                {landingChildren.map(child => (
                  <div key={child.slug} className={'subcategory-strip-tile' + (selectedCategory === child.slug ? ' active' : '')} onClick={() => onCategorySelect(child.slug)}>
                    <div className="subcategory-tile-bg">
                      {child.image_url
                        ? <img src={optimizeImg(child.image_url, 300)} alt="" loading="lazy" decoding="async" />
                        : <div className="subcategory-strip-placeholder" />
                      }
                    </div>
                    <div className="subcategory-tile-label">
                      <span className="subcategory-strip-name">{child.name}</span>
                      <span className="subcategory-strip-count">{child.product_count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="browse-layout">

          <div className="sidebar">
            <FacetPanel {...facetProps} />
          </div>

          <div className="browse-content">
            {hasFilters && (
              <ActiveFilterPills filters={filters} facets={facets} onFilterToggle={onFilterToggle} onClearFilters={onClearFilters}
                vendorFilters={vendorFilters} onVendorToggle={onVendorToggle} userPriceRange={userPriceRange} onPriceRangeChange={onPriceRangeChange}
                tagFilters={tagFilters} tagFacets={tagFacets} onTagToggle={onTagToggle} />
            )}
            <div className="browse-toolbar-row">
              <BrowseToolbar totalSkus={totalSkus} sortBy={sortBy} onSortChange={onSortChange} currentPage={currentPage} viewMode={viewMode} onViewModeChange={setViewMode} searchQuery={searchQuery} searchTimeMs={searchTimeMs} relatedSearches={relatedSearches} onSearch={onSearch} matchingCategories={matchingCategories} onCategorySelect={onCategorySelect} />
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
                <div className="browse-empty">
                  <p>No products found</p>
                  <p>Try adjusting your filters</p>
                </div>
              )
            ) : (
              <>
                <SkuGrid skus={skus} onSkuClick={onSkuClick} wishlist={wishlist} toggleWishlist={toggleWishlist} setQuickViewSku={setQuickViewSku} viewMode={viewMode} />
                {totalPages > 1 && (
                  <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
                )}
              </>
            )}
            {/* Filter Drawer (mobile) */}
            <div className={'filter-drawer-overlay' + (filterDrawerOpen ? ' open' : '')} onClick={() => setFilterDrawerOpen(false)} />
            <div className={'filter-drawer' + (filterDrawerOpen ? ' open' : '')}>
              <div className="filter-drawer-head">
                <h3>Filters{totalActiveFilterCount > 0 && <span className="filter-group-count-badge">{totalActiveFilterCount}</span>}</h3>
                <button className="cart-drawer-close" onClick={() => setFilterDrawerOpen(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              {hasFilters && (
                <div className="filter-drawer-pills">
                  <ActiveFilterPills filters={filters} facets={facets} onFilterToggle={onFilterToggle} onClearFilters={onClearFilters}
                    vendorFilters={vendorFilters} onVendorToggle={onVendorToggle} userPriceRange={userPriceRange} onPriceRangeChange={onPriceRangeChange}
                    tagFilters={tagFilters} tagFacets={tagFacets} onTagToggle={onTagToggle} inline={true} />
                </div>
              )}
              <div className="filter-drawer-body">
                <FacetPanel {...facetProps} isMobile={true} />
              </div>
              <div className="filter-drawer-footer">
                <button className="filter-drawer-results-btn" onClick={() => setFilterDrawerOpen(false)}>
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
                onChange={e => { const v = parseFloat(e.target.value); setLocalMin(isNaN(v) ? min : v); }}
                onBlur={() => commit(localMin, localMax)} />
            </div>
            <span className="price-range-dash">&ndash;</span>
            <div className="price-input-wrap">
              <span>$</span>
              <input type="number" min={min} max={max} step={step} value={localMax}
                onChange={e => { const v = parseFloat(e.target.value); setLocalMax(isNaN(v) ? max : v); }}
                onBlur={() => commit(localMin, localMax)} />
            </div>
          </div>
        </div>
      );
    }

    function FacetPanel({ facets, filters, onFilterToggle, onBatchFilterSet, onClearFilters,
      vendors, vendorFilters, onVendorToggle,
      priceRange, userPriceRange, onPriceRangeChange,
      tagFacets, tagFilters, onTagToggle,
      totalSkus, isMobile }) {

      const hasAttrFilters = Object.keys(filters).length > 0;
      const hasVendorFilters = vendorFilters && vendorFilters.length > 0;
      const hasPriceFilters = userPriceRange && (userPriceRange.min != null || userPriceRange.max != null);
      const hasTagFilters = tagFilters && tagFilters.length > 0;
      const hasAny = hasAttrFilters || hasVendorFilters || hasPriceFilters || hasTagFilters;
      const totalActiveFilterCount = (vendorFilters ? vendorFilters.length : 0) + (hasPriceFilters ? 1 : 0) + (tagFilters ? tagFilters.length : 0) + Object.values(filters).reduce((s, a) => s + a.length, 0);

      const [collapsed, setCollapsed] = useState({});
      const [filterSearch, setFilterSearch] = useState({});
      const [expandedGroups, setExpandedGroups] = useState({});
      const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

      const VALUE_LIMIT = 8;
      const prioritySlugs = ['material', 'finish', 'size', 'application'];
      const bottomSlugs = ['pei_rating', 'water_absorption', 'dcof'];
      // Groups shown before "More Filters" divider
      const primarySlugs = ['material', 'finish', 'size', 'application'];

      const chevron = (isOpen) => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={'filter-chevron' + (isOpen ? ' open' : '')}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );

      // Determine default collapsed state for a group
      const isGroupCollapsed = (slug) => {
        if (collapsed[slug] !== undefined) return collapsed[slug];
        if (filters[slug] && filters[slug].length > 0) return false;
        if (prioritySlugs.includes(slug)) return false;
        if (slug === 'color') return false;
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
        const familyRawValues = colorFacet.values.map(v => v.value).filter(v => {
          const lower = v.toLowerCase().trim();
          return keywords.some(kw => lower.includes(kw));
        });
        if (familyRawValues.length === 0) return;
        const currentColors = filters.color || [];
        const isActive = familyRawValues.some(v => currentColors.includes(v));
        let newColors;
        if (isActive) {
          newColors = currentColors.filter(v => !familyRawValues.includes(v));
        } else {
          newColors = [...currentColors, ...familyRawValues.filter(v => !currentColors.includes(v))];
        }
        onBatchFilterSet('color', newColors);
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

      // Split into primary (shown above "More Filters") and secondary (inside "More Filters")
      const primaryFacets = sortedFacets.filter(g => primarySlugs.includes(g.slug));
      const secondaryFacets = sortedFacets.filter(g => !primarySlugs.includes(g.slug));

      // Auto-expand "More Filters" if any contained facet has active selections
      const hasActiveSecondary = secondaryFacets.some(g => (filters[g.slug] || []).length > 0);
      const showMoreFilters = moreFiltersOpen || hasActiveSecondary;

      // Split tags by category
      const roomTags = (tagFacets || []).filter(t => t.category === 'Room');
      const featureTags = (tagFacets || []).filter(t => t.category !== 'Room');
      const roomTagActiveCount = roomTags.filter(t => (tagFilters || []).includes(t.slug)).length;
      const featureTagActiveCount = featureTags.filter(t => (tagFilters || []).includes(t.slug)).length;

      const FacetCheck = ({ checked, onChange, id }) => (
        <span className={'facet-check' + (checked ? ' checked' : '')} onClick={onChange} role="checkbox" aria-checked={checked} tabIndex={0} id={id}
          onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(); } }}>
          {checked && <svg viewBox="0 0 12 10" fill="none"><polyline points="1.5 5 4.5 8 10.5 2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        </span>
      );

      const renderFilterGroup = (group) => {
        const isCol = isGroupCollapsed(group.slug);
        const searchTerm = filterSearch[group.slug] || '';
        const allValues = searchTerm
          ? group.values.filter(v => v.value.toLowerCase().includes(searchTerm.toLowerCase()))
          : group.values;
        const activeCount = (filters[group.slug] || []).length;
        const checkId = (val) => 'f-' + group.slug + '-' + val.replace(/[^a-zA-Z0-9]/g, '_');
        const isExpanded = expandedGroups[group.slug] || false;
        const shouldTruncate = !searchTerm && allValues.length > VALUE_LIMIT;
        const values = shouldTruncate && !isExpanded ? allValues.slice(0, VALUE_LIMIT) : allValues;
        const hiddenCount = allValues.length - VALUE_LIMIT;

        return (
          <div key={group.slug} className="filter-group">
            <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, [group.slug]: !isCol }))}>
              <span>{group.name}{activeCount > 0 && <span className="filter-group-count-badge">{activeCount}</span>}</span>
              {chevron(!isCol)}
            </div>
            <div className={'filter-group-content' + (isCol ? ' collapsed' : '')}>
              {group.values.length > 15 && (
                <input className="filter-search-input" type="text" placeholder={'Search ' + group.name.toLowerCase() + '...'}
                  value={searchTerm} onChange={e => setFilterSearch(prev => ({ ...prev, [group.slug]: e.target.value }))}
                  onClick={e => e.stopPropagation()} />
              )}
              <div className="filter-values-scroll">
                {values.map(v => {
                  const checked = (filters[group.slug] || []).includes(v.value);
                  return (
                    <div key={v.value} className="filter-option" onClick={() => onFilterToggle(group.slug, v.value)}>
                      <FacetCheck checked={checked} onChange={() => onFilterToggle(group.slug, v.value)} id={checkId(v.value)} />
                      <label htmlFor={checkId(v.value)}>{formatCarpetValue(v.value)}</label>
                      <span className="filter-count">({v.count})</span>
                    </div>
                  );
                })}
                {values.length === 0 && searchTerm && (
                  <div className="filter-no-matches">No matches</div>
                )}
              </div>
              {shouldTruncate && (
                <button className="show-more-btn" onClick={() => setExpandedGroups(prev => ({ ...prev, [group.slug]: !isExpanded }))}>
                  {isExpanded ? 'Show less' : 'Show ' + hiddenCount + ' more'}
                </button>
              )}
            </div>
          </div>
        );
      };

      return (
        <div className="filter-panel">
          {/* Header + Clear All */}
          <div className="sidebar-refine-header">
            <div className="sidebar-refine-top">
              <span className="sidebar-refine-label">Refine</span>
              {hasAny && <span className="sidebar-refine-active">{totalActiveFilterCount} active</span>}
            </div>
            <div className="sidebar-refine-bottom">
              <span className="sidebar-refine-category">{totalSkus ? totalSkus + ' products' : 'All materials'}</span>
              {hasAny && <button className="filter-clear" onClick={onClearFilters}>Clear all</button>}
            </div>
          </div>

          {/* 1. Brand filter */}
          {vendors && vendors.length > 0 && (() => {
            const isCol = collapsed._vendor || false;
            const searchTerm = filterSearch._vendor || '';
            const allVendors = searchTerm
              ? vendors.filter(v => v.name.toLowerCase().includes(searchTerm.toLowerCase()))
              : vendors;
            const isExpanded = expandedGroups._vendor || false;
            const shouldTruncate = !searchTerm && allVendors.length > VALUE_LIMIT;
            const visibleVendors = shouldTruncate && !isExpanded ? allVendors.slice(0, VALUE_LIMIT) : allVendors;
            const hiddenCount = allVendors.length - VALUE_LIMIT;

            return (
              <div className="filter-group vendor-filter-group">
                <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, _vendor: !isCol }))}>
                  <span>Brand{hasVendorFilters && <span className="filter-group-count-badge">{vendorFilters.length}</span>}</span>
                  {chevron(!isCol)}
                </div>
                <div className={'filter-group-content' + (isCol ? ' collapsed' : '')}>
                  {vendors.length > 15 && (
                    <input className="filter-search-input" type="text" placeholder="Search brands..."
                      value={searchTerm} onChange={e => setFilterSearch(prev => ({ ...prev, _vendor: e.target.value }))}
                      onClick={e => e.stopPropagation()} />
                  )}
                  <div className="filter-values-scroll">
                    {visibleVendors.map(v => {
                      const checked = vendorFilters.includes(v.name);
                      return (
                        <div key={v.name} className="filter-option" onClick={() => onVendorToggle(v.name)}>
                          <FacetCheck checked={checked} onChange={() => onVendorToggle(v.name)} id={'f-vendor-' + v.name.replace(/[^a-zA-Z0-9]/g, '_')} />
                          <label htmlFor={'f-vendor-' + v.name.replace(/[^a-zA-Z0-9]/g, '_')}>{v.name}</label>
                          <span className="filter-count">({v.count})</span>
                        </div>
                      );
                    })}
                  </div>
                  {shouldTruncate && (
                    <button className="show-more-btn" onClick={() => setExpandedGroups(prev => ({ ...prev, _vendor: !isExpanded }))}>
                      {isExpanded ? 'Show less' : 'Show ' + hiddenCount + ' more'}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* 2. Room tags (cards) */}
          {roomTags.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-title">
                <span>Room{roomTagActiveCount > 0 && <span className="filter-group-count-badge">{roomTagActiveCount}</span>}</span>
              </div>
              <div className="room-tag-grid">
                {roomTags.map(tag => (
                  <button key={tag.slug}
                    className={'room-tag-card' + ((tagFilters || []).includes(tag.slug) ? ' active' : '')}
                    onClick={() => onTagToggle(tag.slug)}>
                    <span className="room-tag-card-name">{tag.name}</span>
                    <span className="room-tag-card-count">{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 3. Primary attribute facets (Material) */}
          {primaryFacets.filter(g => g.slug === 'material').map(group => renderFilterGroup(group))}

          {/* 4. Color families + color facet */}
          {colorFacet && (() => {
            const isCol = isGroupCollapsed('color');
            return (
              <div className="filter-group">
                <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, color: !isCol }))}>
                  <span>Color{(filters.color || []).length > 0 && <span className="filter-group-count-badge">{(filters.color || []).length}</span>}</span>
                  {chevron(!isCol)}
                </div>
                <div className={'filter-group-content' + (isCol ? ' collapsed' : '')}>
                  {/* Color family swatches */}
                  <div className="color-family-grid">
                    {Object.entries(COLOR_FAMILIES).map(([name, { hex }]) => {
                      if (!familyCounts[name]) return null;
                      const isActive = activeFamilies.includes(name);
                      const style = hex.includes('gradient')
                        ? { background: hex }
                        : { backgroundColor: hex };
                      return (
                        <button key={name} className={'color-family-swatch' + (isActive ? ' active' : '')} onClick={() => handleFamilyClick(name)} title={name + ' (' + familyCounts[name] + ')'}>
                          <div className="color-family-circle" style={style} />
                          <span className="color-family-name">{name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 5. Remaining primary facets (Finish, Size, Application) */}
          {primaryFacets.filter(g => g.slug !== 'material').map(group => renderFilterGroup(group))}

          {/* 6. Price range */}
          {priceRange && priceRange.max > 0 && (() => {
            const isCol = collapsed._price || false;
            return (
              <div className="filter-group">
                <div className="filter-group-title" onClick={() => setCollapsed(prev => ({ ...prev, _price: !isCol }))}>
                  <span>Price{hasPriceFilters && <span className="filter-group-count-badge">1</span>}</span>
                  {chevron(!isCol)}
                </div>
                <div className={'filter-group-content' + (isCol ? ' collapsed' : '')}>
                  <PriceRangeFilter priceRange={priceRange} userPriceRange={userPriceRange || { min: null, max: null }} onChange={onPriceRangeChange} />
                </div>
              </div>
            );
          })()}

          {/* 7. Feature tags (chips) */}
          {featureTags.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-title">
                <span>Features{featureTagActiveCount > 0 && <span className="filter-group-count-badge">{featureTagActiveCount}</span>}</span>
              </div>
              <div className="tag-chips">
                {featureTags.map(tag => (
                  <button key={tag.slug}
                    className={'tag-chip' + ((tagFilters || []).includes(tag.slug) ? ' active' : '')}
                    onClick={() => onTagToggle(tag.slug)}>
                    {tag.name} <span className="filter-count">({tag.count})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 8. "More Filters" — secondary attribute facets */}
          {secondaryFacets.length > 0 && (
            <div className="more-filters-divider">
              <button className="more-filters-toggle" onClick={() => setMoreFiltersOpen(prev => !prev)}>
                <span>More Filters</span>
                {chevron(showMoreFilters)}
              </button>
              <div className={'more-filters-content' + (showMoreFilters ? ' expanded' : ' collapsed')}>
                {secondaryFacets.map(group => renderFilterGroup(group))}
              </div>
            </div>
          )}
        </div>
      );
    }

    function ActiveFilterPills({ filters, facets, onFilterToggle, onClearFilters, vendorFilters, onVendorToggle, userPriceRange, onPriceRangeChange, tagFilters, tagFacets, onTagToggle, inline }) {
      const pills = [];
      // Vendor pills
      (vendorFilters || []).forEach(name => {
        pills.push({ type: 'vendor', value: name, groupLabel: 'Brand', valueLabel: name, onRemove: () => onVendorToggle(name) });
      });
      // Tag pills
      (tagFilters || []).forEach(slug => {
        const tag = (tagFacets || []).find(t => t.slug === slug);
        pills.push({ type: 'tag', value: slug, groupLabel: 'Tag', valueLabel: tag ? tag.name : slug, onRemove: () => onTagToggle(slug) });
      });
      // Price pill
      if (userPriceRange && (userPriceRange.min != null || userPriceRange.max != null)) {
        const valueLabel = '$' + (userPriceRange.min || 0) + ' \u2013 $' + (userPriceRange.max || '\u221E');
        pills.push({ type: 'price', value: 'price', groupLabel: 'Price', valueLabel, onRemove: () => onPriceRangeChange(null, null) });
      }
      // Attribute pills
      Object.keys(filters).forEach(slug => {
        const group = facets.find(f => f.slug === slug);
        const name = group ? group.name : slug;
        (filters[slug] || []).forEach(val => {
          pills.push({ type: 'attr', slug, value: val, groupLabel: name, valueLabel: val, onRemove: () => onFilterToggle(slug, val) });
        });
      });
      if (pills.length === 0) return null;
      // Inline mode: just pills, no wrapper (used in mobile drawer pills strip)
      if (inline) {
        return pills.map((p, i) => (
          <div key={i} className="filter-pill" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span className="filter-pill-group">{p.groupLabel}:</span>
            <span>{p.valueLabel}</span>
            <button onClick={p.onRemove}>&times;</button>
          </div>
        ));
      }
      return (
        <div className="active-filters">
          <span className="active-filters-label">Refined by</span>
          {pills.map((p, i) => (
            <div key={i} className="filter-pill">
              <span className="filter-pill-group">{p.groupLabel}:</span>
              <span>{p.valueLabel}</span>
              <button onClick={p.onRemove}>&times;</button>
            </div>
          ))}
          <button className="filter-clear" onClick={onClearFilters}>Clear all</button>
        </div>
      );
    }

    function BrowseToolbar({ totalSkus, sortBy, onSortChange, currentPage, viewMode, onViewModeChange, searchQuery, searchTimeMs, relatedSearches, onSearch, matchingCategories, onCategorySelect }) {
      const page = currentPage || 1;
      const per = 24;
      const startIdx = (page - 1) * per + 1;
      const endIdx = Math.min(page * per, totalSkus);
      const mode = viewMode || 'grid';
      const isSearching = !!searchQuery;
      return (
        <React.Fragment>
          <div className="browse-toolbar">
            <div className="result-count">
              {totalSkus > 0
                ? 'Showing ' + startIdx + '\u2013' + endIdx + ' of ' + totalSkus + (searchTimeMs != null ? ' in ' + (searchTimeMs / 1000).toFixed(2) + 's' : '')
                : '0 products'
              }
            </div>
            <div className="browse-toolbar-right">
              {onViewModeChange && (
                <div className="view-mode-toggle">
                  {['grid', 'compact', 'spec'].map(m => (
                    <button key={m} className={'view-mode-btn' + (mode === m ? ' active' : '')} onClick={() => onViewModeChange(m)}>
                      {m === 'grid' ? 'Grid' : m === 'compact' ? 'Compact' : 'Spec'}
                    </button>
                  ))}
                </div>
              )}
              <div className="sort-group">
                <span className="sort-label">Sort</span>
                <select value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
                  {isSearching && <option value="relevance">Best Match</option>}
                  <option value="name_asc">Name A-Z</option>
                  <option value="name_desc">Name Z-A</option>
                  <option value="price_asc">{`Price: Low \u2192 High`}</option>
                  <option value="price_desc">{`Price: High \u2192 Low`}</option>
                  <option value="newest">Newest</option>
                </select>
              </div>
            </div>
          </div>
          {isSearching && matchingCategories && matchingCategories.length > 0 && (
            <div className="browse-category-pills">
              {matchingCategories.map(cat => (
                <button key={cat.slug} className="browse-category-pill" onClick={() => onCategorySelect(cat.slug)}>
                  {cat.name}
                  {cat.product_count > 0 && <span className="browse-category-pill-count">{cat.product_count}</span>}
                </button>
              ))}
            </div>
          )}
          {isSearching && relatedSearches && relatedSearches.length > 0 && (
            <div className="browse-related-searches">
              <span className="browse-related-label">Related:</span>
              {relatedSearches.map(term => (
                <button key={term} className="browse-related-pill" onClick={() => onSearch(term)}>
                  {term}
                </button>
              ))}
            </div>
          )}
        </React.Fragment>
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

    function SkuGrid({ skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku, viewMode }) {
      const gridClass = 'sku-grid' + (viewMode === 'compact' ? ' sku-grid--compact' : viewMode === 'spec' ? ' sku-grid--spec' : '');
      return (
        <>
          {viewMode === 'spec' && (
            <div className="spec-header">
              <span></span>
              <div className="spec-header-cols">
                <span className="spec-header-col">Product</span>
                <span className="spec-header-col">Brand</span>
                <span className="spec-header-col">Price</span>
              </div>
            </div>
          )}
          <div className={gridClass}>
            {skus.map((sku, idx) => (
              <SkuCard key={sku.sku_id} sku={sku} index={idx} onClick={() => onSkuClick(sku.sku_id, sku.product_name || sku.collection)}
                isWished={wishlist.includes(sku.sku_id)}
                onToggleWishlist={() => toggleWishlist(sku.sku_id)}
                onQuickView={setQuickViewSku ? () => setQuickViewSku(sku) : null} />
            ))}
          </div>
        </>
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
          <button className="pagination-btn" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>{'\u2190'} Previous</button>
          <div className="pagination-pages">
            {pages.map((p, i) => p === '...' ? (
              <span key={'e' + i} className="pagination-ellipsis">{'\u2026'}</span>
            ) : (
              <button key={p} className={'pagination-num' + (p === currentPage ? ' active' : '')} onClick={() => onPageChange(p)} {...(p === currentPage ? { 'aria-current': 'page' } : {})}>{p}</button>
            ))}
          </div>
          <button className="pagination-btn" disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>Next {'\u2192'}</button>
        </nav>
      );
    }

    function SkuCard({ sku, onClick, isWished, onToggleWishlist, onQuickView, index }) {
      const isAboveFold = index != null && index < 8;
      const onSale = sku.sale_price != null && !sku.trade_price;
      const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
      const price = sku.trade_price || (onSale ? sku.sale_price : basePrice);
      const discountPct = onSale && parseFloat(basePrice) > 0 ? Math.round((1 - parseFloat(sku.sale_price) / parseFloat(basePrice)) * 100) : 0;
      const catName = sku.category_name || '';
      const variantLabel = sku.variant_name || '';
      const vendorLabel = sku.brand_name || sku.vendor_name || '';
      const stockStatus = sku.stock_status || 'unknown';
      const lowStockQty = sku.low_stock_qty;
      const stockLabel = stockStatus === 'in_stock' ? 'In stock'
        : stockStatus === 'low_stock' ? (lowStockQty ? (sku.sell_by === 'unit' ? 'Only ' + lowStockQty + ' left' : sku.sell_by === 'box' ? 'Only ' + lowStockQty + ' boxes left' : 'Low stock') : 'Low stock')
        : stockStatus === 'out_of_stock' ? 'Out of stock' : '';
      const stockClass = stockStatus === 'in_stock' ? 'sku-card-stock--in' : stockStatus === 'low_stock' ? 'sku-card-stock--low' : 'sku-card-stock--out';
      const hasVariants = sku.variant_count > 1;
      const variantImages = sku.variant_images || [];
      return (
        <div className="sku-card" onClick={onClick} data-sku={sku.vendor_sku || sku.internal_sku}>
          <div className="sku-card-image">
            {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 400)} {...optimizeSrcSet(sku.primary_image, [200, 400, 600])} sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw" alt={sku.product_name} loading={isAboveFold ? 'eager' : 'lazy'} fetchPriority={isAboveFold ? 'high' : 'auto'} decoding={isAboveFold ? 'sync' : 'async'} width="300" height="280" />}
            {sku.alternate_image && <img className="sku-card-alt-img" onLoad={handleProductImgLoad} src={optimizeImg(sku.alternate_image, 400)} {...optimizeSrcSet(sku.alternate_image, [200, 400, 600])} sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw" alt="" loading="lazy" decoding="async" width="300" height="280" />}
            {onSale && <span className="sale-badge">SALE</span>}
            {/* Hover overlay with wishlist + compare */}
            <div className="sku-card-hover-actions">
              <button className={'sku-card-action-btn wishlist-heart' + (isWished ? ' active' : '')}
                onClick={(e) => { e.stopPropagation(); onToggleWishlist(); }} title="Save to wishlist">
                <svg viewBox="0 0 24 24" fill={isWished ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
                </svg>
              </button>
            </div>
            {/* Gradient quick-view CTA at bottom */}
            {onQuickView && (
              <div className="sku-card-qv-gradient" onClick={(e) => { e.stopPropagation(); onQuickView(); }}>
                <button className="sku-card-qv-btn">Quick View</button>
              </div>
            )}
          </div>
          <div className="sku-card-body">
            <div className="sku-card-meta-row">
              <span>{catName}</span>
              {stockLabel && <span className={'sku-card-stock ' + stockClass}>{'\u25CF'} {stockLabel}</span>}
            </div>
            <div className="sku-card-name">{fullProductName(sku)}</div>
            {hasVariants && variantImages.length > 0 && (
              <div className="sku-card-variant-swatches">
                {variantImages.slice(0, 5).map((vi, i) => (
                  <div key={i} className="sku-card-variant-dot">
                    {vi.image ? <img src={optimizeImg(vi.image, 60)} alt="" loading="lazy" decoding="async" width={22} height={22} /> : null}
                  </div>
                ))}
                {variantImages.length > 5 && <span className="sku-card-variant-more">+{variantImages.length - 5}</span>}
              </div>
            )}
            <div className="sku-card-vendor">
              {variantLabel && vendorLabel ? variantLabel + ' \u00B7 ' + vendorLabel : vendorLabel || variantLabel}
              {!variantLabel && !vendorLabel && hasVariants && (
                sku.variant_count + ' ' + ((sku.attributes || []).some(a => a.slug === 'color') ? 'colors' : 'options')
              )}
            </div>
            <div className="sku-card-price-row">
              <div className="sku-card-price">
                {price ? (
                  <>
                    {sku.trade_price && basePrice && (
                      <span className="sku-card-trade-strike">
                        ${displayPrice(sku, basePrice).toFixed(2)}
                      </span>
                    )}
                    {onSale && (
                      <span className="sale-original-price">
                        ${displayPrice(sku, basePrice).toFixed(2)}
                      </span>
                    )}
                    <span className={onSale ? 'sale-price-text' : ''}>
                      ${displayPrice(sku, price).toFixed(2)}
                    </span>
                    <span className="price-suffix">{priceSuffix(sku)}</span>
                  </>
                ) : 'Call for Price'}
              </div>
              <span className="sku-card-view-link">View &rarr;</span>
            </div>
          </div>
        </div>
      );
    }

    // ==================== SKU Detail View ====================

    function SkuDetailView({ skuId, goBack, addToCart, cart, onSkuClick, onRequestInstall, tradeCustomer, wishlist, toggleWishlist, recentlyViewed, addRecentlyViewed, customer, customerToken, onShowAuth, showToast, categories }) {
      const [sku, setSku] = useState(null);
      const [media, setMedia] = useState([]);
      const [siblings, setSiblings] = useState([]);
      const [skuAccessories, setSkuAccessories] = useState([]);
      const [collectionSiblings, setCollectionSiblings] = useState([]);
      const [collectionAttributes, setCollectionAttributes] = useState({});
      const [groupedProducts, setGroupedProducts] = useState([]);
      const [formatSiblings, setFormatSiblings] = useState([]);
      const [formatLabel, setFormatLabel] = useState(null);
      const [productTags, setProductTags] = useState([]);
      const [countertopImage, setCountertopImage] = useState(null);
      const [selectedImage, setSelectedImage] = useState(0);
      const [expandedAdexCats, setExpandedAdexCats] = useState(new Set());
      const [loading, setLoading] = useState(true);
      const [fetchError, setFetchError] = useState(null);
      const [addingToCart, setAddingToCart] = useState(false);

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

      // Section refs for scroll navigation
      const sectionRefs = {
        details: useRef(null),
        companions: useRef(null),
        variants: useRef(null),
        collection: useRef(null),
        recent: useRef(null),
        reviews: useRef(null),
      };
      const navRef = useRef(null);

      // Scroll spy — direct DOM manipulation to avoid re-render timing issues
      useEffect(() => {
        const handleScroll = () => {
          const nav = navRef.current;
          if (!nav) return;
          // Show/hide nav based on scroll position
          const show = window.scrollY > 300;
          nav.classList.toggle('visible', show);
          // Determine active section
          const offset = 140;
          const entries = Object.entries(sectionRefs);
          let current = 'details';
          for (const [key, ref] of entries) {
            if (ref.current) {
              const rect = ref.current.getBoundingClientRect();
              if (rect.top <= offset) current = key;
            }
          }
          // Update active button
          nav.querySelectorAll('.pdp-section-nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.section === current);
          });
        };
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
      }, []);

      const scrollToSection = (key) => {
        const ref = sectionRefs[key];
        if (ref && ref.current) {
          const navH = navRef.current ? navRef.current.offsetHeight : 0;
          const y = ref.current.getBoundingClientRect().top + window.scrollY - 90 - navH - 12;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      };

      // Dual-column independent scroll — scroll-direction-aware sticky
      const galleryRef = useRef(null);
      const infoRef = useRef(null);
      const reviewsSidebarRef = useRef(null);
      const reviewsMainRef = useRef(null);
      useEffect(() => {
        let lastScrollY = window.scrollY;
        let galleryTop = 0;
        let infoTop = 0;
        let revSidebarTop = 0;
        let revMainTop = 0;
        const HEADER_BASE = 90;
        const updateStickyPair = (colA, colB, delta, vh, header) => {
          const cols = [colA, colB];
          for (const col of cols) {
            if (!col.el) continue;
            const h = col.el.offsetHeight;
            if (h <= vh - header) {
              col.top = header;
            } else if (delta > 0) {
              const maxTop = -(h - vh);
              col.top = Math.max(maxTop, col.top - delta);
              col.top = Math.min(col.top, header);
            } else {
              col.top = Math.min(header, col.top - delta);
              col.top = Math.max(col.top, -(h - vh));
            }
            col.el.style.top = col.top + 'px';
          }
          return cols;
        };
        const handleDualSticky = () => {
          if (window.innerWidth < 769) return;
          const scrollY = window.scrollY;
          const delta = scrollY - lastScrollY;
          const vh = window.innerHeight;
          const nav = document.querySelector('.pdp-section-nav');
          const navH = (nav && nav.classList.contains('visible')) ? nav.offsetHeight : 0;
          const HEADER = HEADER_BASE + navH;
          // PDP gallery / info columns
          const gallery = galleryRef.current;
          const info = infoRef.current;
          if (gallery && info) {
            const r = updateStickyPair(
              { el: gallery, top: galleryTop },
              { el: info, top: infoTop },
              delta, vh, HEADER
            );
            galleryTop = r[0].top;
            infoTop = r[1].top;
          }
          // Reviews sidebar / main columns
          const revSidebar = reviewsSidebarRef.current;
          const revMain = reviewsMainRef.current;
          if (revSidebar && revMain) {
            const r = updateStickyPair(
              { el: revSidebar, top: revSidebarTop },
              { el: revMain, top: revMainTop },
              delta, vh, HEADER
            );
            revSidebarTop = r[0].top;
            revMainTop = r[1].top;
          }
          lastScrollY = scrollY;
        };
        window.addEventListener('scroll', handleDualSticky, { passive: true });
        return () => window.removeEventListener('scroll', handleDualSticky);
      }, []);

      useEffect(() => {
        setLoading(true);
        setFetchError(null);
        setSelectedImage(0);
        setMedia([]);
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
            setSkuAccessories(data.accessories || []);
            setCollectionSiblings(data.collection_siblings || []);
            setCollectionAttributes(data.collection_attributes || {});
            setGroupedProducts(data.grouped_products || []);
            setFormatSiblings(data.format_siblings || []);
            setFormatLabel(data.format_label || null);
            setCountertopImage(data.countertop_image || null);
            setProductTags(data.tags || []);
            setLoading(false);
            if (data.sku && addRecentlyViewed) {
              addRecentlyViewed({ sku_id: data.sku.sku_id, product_name: data.sku.product_name, variant_name: data.sku.variant_name, primary_image: (data.media && data.media[0]) ? data.media[0].url : null, retail_price: data.sku.retail_price, cut_price: data.sku.cut_price, price_basis: data.sku.price_basis, sell_by: data.sku.sell_by, sqft_per_box: data.sku.sqft_per_box });
            }
            if (data.sku) {
              const skuTitle = fullProductName(data.sku) + ' | Roma Flooring Designs';
              const skuDesc = cleanDescription(data.sku.description_short, data.sku.brand_name || data.sku.vendor_name) || ('Premium ' + data.sku.product_name + ' from Roma Flooring Designs');
              const skuImage = (data.media && data.media[0]) ? data.media[0].url : null;
              updateSEO({ title: skuTitle, description: skuDesc, url: SITE_URL + '/shop/sku/' + skuId, image: skuImage });
              // Fetch reviews for this product
              fetch(API + '/api/storefront/products/' + data.sku.product_id + '/reviews')
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
                    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
        const skuDesc = cleanDescription(sku.description_short, sku.brand_name || sku.vendor_name) || ('Premium ' + sku.product_name + ' from Roma Flooring Designs');
        const skuImage = (media && media[0]) ? media[0].url : null;
        const product = {
          '@type': 'Product', name: sku.product_name, description: skuDesc, image: skuImage,
          sku: sku.sku_code || String(sku.sku_id),
          mpn: sku.sku_code || '',
          brand: { '@type': 'Brand', name: sku.brand_name || sku.vendor_name || 'Roma Flooring Designs' },
          category: sku.category_name || '',
          offers: { '@type': 'Offer', url: SITE_URL + '/shop/sku/' + skuId, priceCurrency: 'USD',
            price: displayPrice(sku, sku.sale_price || skuListPrice(sku)).toFixed(2),
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
      const retailPrice = sku ? displayPrice(sku, skuListPrice(sku)) : 0;
      const salePrice = sku && sku.sale_price ? displayPrice(sku, sku.sale_price) : null;
      const tradePrice = sku && sku.trade_price ? displayPrice(sku, sku.trade_price) : null;
      const msrpAttr = sku && (sku.attributes || []).find(a => a.slug === 'msrp');
      const msrpPrice = msrpAttr && parseFloat(msrpAttr.value) > 0 ? parseFloat(msrpAttr.value) : null;
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
      const carpetSqft = includeCarpetOverage ? Math.ceil(carpetRawSqft * 11 / 10) : carpetRawSqft;
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
      const isSoldPerSqft = sku && sku.sell_by === 'sqft';
      const hasBoxCalc = !isPerUnit && !isSoldPerSqft && sqftPerBox > 0;
      const isSqftNoBox = !isPerUnit && !isSoldPerSqft && sqftPerBox <= 0;
      // Sheet vinyl roll calculator
      const sheetRollWidthFt = isSqftNoBox && !isCarpetSku && sku
        ? parseRollWidthFt(sku.product_name || '') : 0;
      const isSheetVinyl = isSqftNoBox && !isCarpetSku && sheetRollWidthFt > 0;
      const sheetMode = isSheetVinyl
        ? (carpetInputMode === 'linear' && sheetRollWidthFt <= 0 ? 'dimensions' : carpetInputMode)
        : null;
      const sheetRawSqft = isSheetVinyl
        ? (sheetMode === 'linear' ? sheetRollWidthFt * (parseFloat(linearFeet) || 0)
          : sheetMode === 'dimensions' ? (parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0)
          : parseFloat(sqftInput) || 0)
        : 0;
      const sheetSqft = isSheetVinyl && includeCarpetOverage
        ? Math.ceil(sheetRawSqft * 11 / 10) : sheetRawSqft;
      const sheetSubtotal = sheetSqft * effectivePrice;
      const sheetNeedsSeam = isSheetVinyl && sheetMode === 'dimensions'
        && sheetRollWidthFt > 0 && (parseFloat(roomWidth) || 0) > sheetRollWidthFt;
      // Slab with per-sqft pricing but no known dimensions — can't compute piece price
      const slabMissingSize = isPerUnit && sku && (sku.price_basis === 'sqft' || sku.price_basis === 'per_sqft') && !(parseFloat(sku.sqft_per_box) > 0);
      // Use "sheet" for individually-sold tiles (small coverage, no pieces_per_box)
      // A slab is a single piece — a multi-piece box is sheet goods (mosaic/panel), not a slab
      const isSlabUnit = sku && sku.sell_by === 'unit' && sqftPerBox >= 4 && !(parseInt(sku.pieces_per_box) > 1);
      const isSheetUnit = !isSlabUnit && hasBoxCalc && sqftPerBox < 4 && !sku.pieces_per_box;
      const boxLabel = isSlabUnit ? 'slab' : isSheetUnit ? 'sheet' : 'box';
      const boxLabelPlural = isSlabUnit ? 'slabs' : isSheetUnit ? 'sheets' : 'boxes';
      const unitSubtotal = unitQty * effectivePrice;
      const sqftOnlySubtotal = (parseFloat(sqftInput) || 0) * effectivePrice;
      const sqftCalcRaw = parseFloat(sqftInput) || 0;
      const sqftCalcAmount = isSoldPerSqft && includeOverage ? Math.ceil(sqftCalcRaw * 11 / 10) : sqftCalcRaw;
      const sqftCalcSubtotal = sqftCalcAmount * effectivePrice;

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

      const isOutOfStock = sku && sku.stock_status === 'out_of_stock' && sku.vendor_has_inventory !== false;

      const handleAddToCart = () => {
        if (!sku || addingToCart || isOutOfStock) return;
        setAddingToCart(true);
        setTimeout(() => setAddingToCart(false), 1500);
        if (isCarpetSku) {
          if (carpetSqft <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: carpetSqft,
            num_boxes: 1,
            unit_price: carpetActivePrice,
            subtotal: carpetSubtotal.toFixed(2),
            sell_by: 'roll',
            price_tier: carpetPriceTier
          });
        } else if (isPerUnit) {
          if (unitQty <= 0 || slabMissingSize) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            num_boxes: unitQty,
            unit_price: effectivePrice,
            subtotal: unitSubtotal.toFixed(2),
            sell_by: 'unit'
          });
        } else if (isSoldPerSqft) {
          if (sqftCalcAmount <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: sqftCalcAmount,
            num_boxes: 1,
            unit_price: effectivePrice,
            subtotal: sqftCalcSubtotal.toFixed(2),
            sell_by: 'sqft'
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
            sell_by: 'box'
          });
        } else if (isSheetVinyl) {
          // Sheet vinyl roll — sell by box
          if (sheetSqft <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: sheetSqft,
            num_boxes: 1,
            unit_price: effectivePrice,
            subtotal: sheetSubtotal.toFixed(2),
            sell_by: 'box'
          });
        } else {
          // sqft product without box data — sell by box directly
          const sqft = parseFloat(sqftInput) || 0;
          if (sqft <= 0) return;
          addToCart({
            product_id: sku.product_id,
            sku_id: sku.sku_id,
            sqft_needed: sqft,
            num_boxes: 1,
            unit_price: effectivePrice,
            subtotal: (sqft * effectivePrice).toFixed(2),
            sell_by: 'box'
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
                      {rv.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(rv.primary_image, 400)} alt={rv.product_name} loading="lazy" />}
                    </div>
                    <div className="sibling-card-name">{fullProductName(rv)}</div>
                    {skuListPrice(rv) && <div className="sibling-card-price">${displayPrice(rv, skuListPrice(rv)).toFixed(2)}{priceSuffix(rv)}</div>}
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
                  <a key={cat.slug} className="not-found-cat-link" href="#" onClick={e => { e.preventDefault(); goBack(); }}>{cat.name}</a>
                ))}
              </div>
            </div>
          )}
        </div>
      );

      // Only show skeleton on initial load (no previous sku data).
      // When switching variants, keep existing content visible while fetching.
      if (loading && !sku) return (
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

      const images = media.filter(m => m.asset_type === 'primary' || m.asset_type === 'alternate' || m.asset_type === 'swatch' || m.asset_type === 'lifestyle');
      const specPdfs = media.filter(m => m.asset_type === 'spec_pdf');
      const mainImage = images[selectedImage] || images[0];

      // Siblings are now only non-accessory SKUs (accessories filtered server-side)
      const mainSiblings = siblings;

      // Per-SKU accessories come directly from the server (sku_accessories table)
      const accessorySiblings = groupedProducts.length > 0 ? [] : skuAccessories;

      // ADEX products use a 3-row variant selector (Color / Finish / Type) + grouped collection siblings
      const isAdexProduct = /adex/i.test(sku.vendor_name || '');

      // Build sections list for nav
      const navSections = [{ key: 'details', label: 'Details' }];
      if (groupedProducts.length > 0) navSections.push({ key: 'companions', label: 'Complete the Look' });
      if (!isAdexProduct && mainSiblings.length > 0) navSections.push({ key: 'variants', label: 'Variants' });
      if (!isAdexProduct && collectionSiblings.length > 0) navSections.push({ key: 'collection', label: 'Collection' });
      if (recentlyViewed && recentlyViewed.filter(r => r.sku_id !== skuId).length > 0) navSections.push({ key: 'recent', label: 'Recently Viewed' });
      navSections.push({ key: 'reviews', label: 'Reviews' });

      return (
        <>
          <div className="pdp-section-nav" ref={navRef}>
            {navSections.map(s => (
              <button key={s.key} data-section={s.key} className={'pdp-section-nav-btn' + (s.key === 'details' ? ' active' : '')} onClick={() => scrollToSection(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <div key={sku.sku_id} className={'sku-detail' + (images.every(img => /swatch|alternate/i.test(img.asset_type || '')) ? ' sku-detail--contain' : '')} data-sku={sku.vendor_sku || sku.internal_sku} style={loading ? { opacity: 0.6, pointerEvents: 'none', transition: 'opacity 0.15s ease' } : { animation: 'pdpFadeIn 280ms ease-out both' }}>
            <button className="pdp-back-btn" onClick={goBack} aria-label="Back">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            </button>
            <div className="pdp-breadcrumbs">
              <a href="#" onClick={e => { e.preventDefault(); goBack(); }}>Shop</a>
              <span className="pdp-crumb"></span>
              {sku.category_name && <><a href="#" onClick={e => { e.preventDefault(); goBack(); }}>{sku.category_name}</a><span className="pdp-crumb"></span></>}
              <span style={{ color: 'var(--stone-900)' }}>{fullProductName(sku)}</span>
            </div>

            <div className="sku-detail-main" ref={sectionRefs.details}>
            <div className="sku-detail-gallery" ref={galleryRef}>
              <div className="sku-detail-image">
                {mainImage && <img onLoad={handleProductImgLoad} src={optimizeImg(mainImage.url, 800)} {...optimizeSrcSet(mainImage.url, [400, 600, 800, 1200])} sizes="(max-width: 768px) 100vw, 50vw" alt={sku.product_name} fetchPriority="high" decoding="async" />}
              </div>
              {images.length > 1 && (
                <div className="gallery-thumbs">
                  {images.map((img, i) => {
                    return (
                      <div key={img.id} className={'gallery-thumb' + (i === selectedImage ? ' active' : '')} onClick={() => setSelectedImage(i)}>
                        <img onLoad={handleProductImgLoad} src={optimizeImg(img.url, 120)} alt="" loading="lazy" decoding="async" width="80" height="80" />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Specs — below gallery */}
              {(() => {
                const HIDDEN_SLUGS = new Set(['price_list', 'material_class', 'style_code', 'companion_skus', 'subcategory', 'msrp', 'top_ref_sku', 'sink_ref_sku', 'optional_accessories', 'group_number']);
                const ORDER = ['_collection', '_category', '_sku', 'collection', 'species', 'color', 'color_code', 'brand', 'application', 'fiber', 'material', 'construction', 'finish', 'style', 'pattern', 'size', 'thickness', 'width', 'wear_layer', 'weight', 'weight_per_sqyd', 'roll_width', 'roll_length'];
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
                if (!slugMap.collection) {
                  const collectionVal = (sku.collection && sku.category_name && sku.collection === sku.category_name)
                    ? sku.product_name
                    : sku.collection;
                  if (collectionVal) sorted.unshift({ slug: '_collection', name: 'Collection', value: collectionVal });
                }
                const injectedCollection = sorted.find(a => a.slug === '_collection');
                if (sku.category_name && (!injectedCollection || injectedCollection.value !== sku.category_name)) {
                  const insertIdx = injectedCollection ? 1 : 0;
                  sorted.splice(insertIdx, 0, { slug: '_category', name: 'Category', value: sku.category_name });
                }
                if (sku.vendor_sku) {
                  const afterCat = sorted.findIndex(a => a.slug === '_category');
                  sorted.splice(afterCat >= 0 ? afterCat + 1 : (injectedCollection ? 1 : 0), 0, { slug: '_sku', name: 'SKU', value: (sku.vendor_sku || '').toUpperCase() });
                }
                const priceListAttr = (sku.attributes || []).find(a => a.slug === 'price_list');
                if (priceListAttr && priceListAttr.value && !slugMap.brand) {
                  const brandLine = priceListAttr.value.replace(/\s+\d+$/, '');
                  const ccIdx = sorted.findIndex(a => a.slug === 'color_code');
                  sorted.splice(ccIdx >= 0 ? ccIdx + 1 : sorted.length, 0, { slug: '_brand', name: 'Brand', value: brandLine });
                }
                if (sorted.length === 0) return null;
                return (
                  <div style={{ marginTop: '2.5rem' }}>
                    <div className="pdp-section-label">Specifications</div>
                    <table className="specs-table">
                      <tbody>
                        {sorted.map((a, i) => (
                          <tr key={i}><td>{a.name}</td><td>{a.slug === '_sku' ? a.value : formatCarpetValue(a.value)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* Description */}
              {(sku.description_long || sku.description_short) && (() => {
                const cleaned = cleanDescription(sku.description_long || sku.description_short, sku.brand_name || sku.vendor_name);
                return cleaned ? (
                  <div className="pdp-desc-section">
                    <div className="pdp-desc-label">About this product</div>
                    <p className="pdp-description">{cleaned}</p>
                  </div>
                ) : null;
              })()}

              {/* Documentation */}
              {specPdfs.length > 0 && (
                <div className="pdp-docs-section">
                <div className="pdp-docs-label">Documentation</div>
                <div className="pdp-pdf-grid">
                  {specPdfs.map(pdf => (
                    <a key={pdf.id} href={pdf.url} target="_blank" rel="noopener noreferrer" className="pdp-pdf-card">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18 }}>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/>
                      </svg>
                      <span>
                        {(() => { const fn = (pdf.url || '').split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '); return fn.length > 3 ? fn.replace(/\b\w/g, c => c.toUpperCase()) : 'Spec Sheet'; })()}
                        <span className="pdp-pdf-type">PDF</span>
                      </span>
                    </a>
                  ))}
                </div>
                </div>
              )}
            </div>

            <div className="sku-detail-info" ref={infoRef}>
              {/* Category · Collection label */}
              <div className="pdp-category-label">
                {sku.category_name}{sku.collection && sku.collection !== sku.category_name && sku.collection !== sku.vendor_name && sku.collection !== sku.brand_name ? ' \u00B7 ' + sku.collection : ''}
              </div>

              {/* Title row with wishlist heart */}
              <div className="pdp-title-row">
                <h1 className="sku-detail-title-row">
                  {cleanProductTitle(sku.product_name, sku) || fullProductName(sku)}
                </h1>
                <button className={'pdp-wishlist-heart' + (wishlist.includes(sku.sku_id) ? ' active' : '')} onClick={() => toggleWishlist(sku.sku_id)} aria-label={wishlist.includes(sku.sku_id) ? 'Remove from wishlist' : 'Add to wishlist'}>
                  <svg viewBox="0 0 24 24" fill={wishlist.includes(sku.sku_id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18 }}>
                    <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
                  </svg>
                </button>
              </div>

              {/* Variant name (italic) */}
              {(sku.variant_name || (sku.attributes && sku.attributes.length > 0)) && <div className="pdp-variant-name">{pdpSubtitle(sku)}</div>}

              {/* SKU · Vendor line */}
              <div className="pdp-sku-line">
                {sku.vendor_sku && <><span style={{ color: 'var(--stone-500)' }}>SKU</span> <span style={{ margin: '0 0.25rem', color: 'var(--stone-400)' }}>&middot;</span> <span className="pdp-sku-val">{(sku.vendor_sku || '').toUpperCase()}</span><span className="pdp-sku-sep"></span></>}
                <span>{sku.vendor_name || sku.brand_name || ''}</span>
              </div>

              {productTags.length > 0 && (
                <div className="product-tag-badges">
                  {productTags.map(t => <span key={t.slug} className="product-tag-badge">{t.name}</span>)}
                </div>
              )}

              <div className="sku-detail-price">
                {isCarpet(sku) ? (
                  <>
                    <div className="pdp-price-main">
                      <span className="pdp-price-amount">${parseFloat(sku.cut_price).toFixed(2)}</span>
                      <span className="pdp-price-suffix">/sqyd &middot; ${carpetSqftPrice(sku.cut_price)}/sqft</span>
                      {tradePrice && <span className="pdp-price-badge trade">Trade</span>}
                    </div>
                    {sku.roll_price && parseFloat(sku.roll_price) < parseFloat(sku.cut_price) && (
                      <div className="pdp-price-roll-badge">
                        Roll ${parseFloat(sku.roll_price).toFixed(2)}/sqyd{sku.roll_min_sqft ? ' \u00B7 ' + parseFloat(sku.roll_min_sqft).toFixed(0) + ' sqft min' : ''}
                      </div>
                    )}
                  </>
                ) : tradePrice ? (
                  <>
                    <div className="pdp-price-main">
                      <span className="pdp-price-amount">${tradePrice.toFixed(2)}</span>
                      <span className="pdp-price-suffix">{priceSuffix(sku)}</span>
                      <span className="pdp-price-strike">${retailPrice.toFixed(2)}</span>
                      <span className="pdp-price-badge trade">Trade</span>
                    </div>
                    {!isPerUnit && sqftPerBox > 0 && (
                      <div className="pdp-price-per-box">${(tradePrice * sqftPerBox).toFixed(2)} per {boxLabel} &middot; {sqftPerBox} sqft{sku.pieces_per_box ? ' \u00B7 ' + sku.pieces_per_box + ' pieces' : ''}</div>
                    )}
                  </>
                ) : salePrice ? (
                  <>
                    <div className="pdp-price-main">
                      <span className="pdp-price-amount">${salePrice.toFixed(2)}</span>
                      <span className="pdp-price-suffix">{priceSuffix(sku)}</span>
                      <span className="pdp-price-strike">${retailPrice.toFixed(2)}</span>
                      {retailPrice > 0 && <span className="pdp-price-badge sale">{Math.round((1 - salePrice / retailPrice) * 100)}% off</span>}
                    </div>
                    {!isPerUnit && sqftPerBox > 0 && (
                      <div className="pdp-price-per-box">${(salePrice * sqftPerBox).toFixed(2)} per {boxLabel} &middot; {sqftPerBox} sqft{sku.pieces_per_box ? ' \u00B7 ' + sku.pieces_per_box + ' pieces' : ''}</div>
                    )}
                  </>
                ) : retailPrice > 0 ? (
                  <>
                    <div className="pdp-price-main">
                      {msrpPrice && msrpPrice > retailPrice && <span className="pdp-price-strike">${msrpPrice.toFixed(2)}</span>}
                      <span className="pdp-price-amount">${retailPrice.toFixed(2)}</span>
                      <span className="pdp-price-suffix">{priceSuffix(sku)}</span>
                    </div>
                    {!isPerUnit && sqftPerBox > 0 && (
                      <div className="pdp-price-per-box">${(retailPrice * sqftPerBox).toFixed(2)} per {boxLabel} &middot; {sqftPerBox} sqft{sku.pieces_per_box ? ' \u00B7 ' + sku.pieces_per_box + ' pieces' : ''}</div>
                    )}
                  </>
                ) : (
                  <div className="pdp-price-main">
                    <span className="pdp-price-amount" style={{ fontSize: '1.5rem' }}>Call for Price</span>
                  </div>
                )}
              </div>

              {/* Klarna Pay-in-4 badge — illustrative installment on the smallest purchasable unit */}
              {(() => {
                const effUnit = tradePrice || salePrice || retailPrice || 0;
                const isBoxPriced = !isPerUnit && sqftPerBox > 0 && !isCarpet(sku);
                const klarnaBase = isCarpet(sku)
                  ? (parseFloat(sku.cut_price) || 0)
                  : (isBoxPriced ? effUnit * sqftPerBox : effUnit);
                if (!(klarnaBase >= 35)) return null;
                const unitLabel = isCarpet(sku) ? 'sq yd' : (isBoxPriced ? boxLabel : 'item');
                return (
                  <div className="pdp-klarna">
                    <span className="pdp-klarna-icon">Klarna.</span>
                    <span className="pdp-klarna-text">4 interest-free payments of <strong>${(klarnaBase / 4).toFixed(2)}</strong> per {unitLabel}. No fees.</span>
                  </div>
                );
              })()}

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

              {/* Slab Dimensions */}
              {(() => {
                const isSlab = /slab|countertop/i.test(sku.category_name || '') || /slab/i.test(sku.variant_name || '') || /slab/i.test(sku.product_name || '');
                if (!isSlab) return null;
                const sa = {};
                (sku.attributes || []).forEach(a => { sa[a.slug] = a.value; });
                const size = sa.size;
                const thickness = sa.thickness;
                if (!size && !thickness) return null;
                const dims = [];
                if (size && size !== 'Variable') {
                  const parts = size.replace(/ Slab$/i, '').split('x');
                  if (parts.length === 2) dims.push({ label: 'Slab Size', value: parts[0].trim() + '" \u00D7 ' + parts[1].trim() + '"' });
                  else dims.push({ label: 'Slab Size', value: size });
                } else if (size === 'Variable') {
                  dims.push({ label: 'Slab Size', value: 'Variable (natural stone)' });
                }
                if (thickness) dims.push({ label: 'Thickness', value: thickness });
                if (dims.length === 0) return null;
                return (
                  <div className="carpet-specs-band">
                    {dims.map((d, i) => (
                      <div key={i} className="carpet-spec-card">
                        <div className="carpet-spec-card-label">{d.label}</div>
                        <div className="carpet-spec-card-value">{d.value}</div>
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
                  const curSizeAttr = (sku.attributes || []).find(a => a.slug === 'size');
                  const curSize = curSizeAttr ? curSizeAttr.value : '';
                  allCollection.push({
                    sku_id: sku.sku_id, product_name: sku.product_name, variant_name: sku.variant_name,
                    primary_image: curSkuPrimary ? curSkuPrimary.url : null,
                    color: curColor, finish: curFinish, size: curSize
                  });
                  seenIds.add(sku.sku_id);

                  // Same-product siblings — use sku_image (SKU-only, no product fallback) for color swatches
                  mainSiblings.forEach(s => {
                    if (seenIds.has(s.sku_id)) return;
                    seenIds.add(s.sku_id);
                    allCollection.push({ ...s, product_name: sku.product_name, color: s.color || ((s.attributes || []).find(a => a.slug === 'color') || {}).value || '', finish: s.finish || ((s.attributes || []).find(a => a.slug === 'finish') || {}).value || '', size: s.size || ((s.attributes || []).find(a => a.slug === 'size') || {}).value || '', primary_image: s.sku_image || null });
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
                      const rep = sameProductFinish.find(s => s.color === color && s.size === curSize)
                        || sameProductFinish.find(s => s.color === color);
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
                                    {c.primary_image ? <img onLoad={handleProductImgLoad} src={optimizeImg(c.primary_image, 120)} alt={c.color} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 600, color: 'var(--stone-500)', textAlign: 'center', lineHeight: 1.2, padding: '4px' }}>{c.color}</div>}
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
                                const match = sameProductColor.find(s => s.finish === f && s.size === curSize)
                                  || sameProductColor.find(s => s.finish === f)
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
                            let name = s.product_name;
                            if (/^End Cap|^Frame Corner|^Beak|^FE Corner/i.test(prefix)) name = s.product_name + ' — ' + prefix;
                            if (s.size) name += ' ' + s.size;
                            return name;
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
                              {orderedGroups.map(cat => {
                                const MAX_VISIBLE = 12;
                                const items = groups[cat];
                                const isExpanded = expandedAdexCats.has(cat);
                                const visibleItems = isExpanded ? items : items.slice(0, MAX_VISIBLE);
                                const hasMore = items.length > MAX_VISIBLE;
                                return (
                                <div key={cat} style={{ marginBottom: '1.25rem' }}>
                                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>{cat}</div>
                                  <div className="variant-grid">
                                    {visibleItems.map(s => (
                                      <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                                        <div className="sibling-card-image">
                                          {getVariantImage(s) && <img onLoad={handleProductImgLoad} src={optimizeImg(getVariantImage(s), 120)} alt={displayName(s)} loading="lazy" decoding="async" />}
                                        </div>
                                        <div className="sibling-card-name">{displayName(s)}</div>
                                        {skuListPrice(s) && <div className="sibling-card-price">${displayPrice(s, skuListPrice(s)).toFixed(2)}{priceSuffix(s)}</div>}
                                      </div>
                                    ))}
                                  </div>
                                  {hasMore && !isExpanded && (
                                    <button className="show-more-btn" onClick={() => setExpandedAdexCats(prev => new Set([...prev, cat]))}>
                                      Show all {items.length} pieces
                                    </button>
                                  )}
                                </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  }
                }

                // Build colorItems for the Color swatch row.
                //
                // Preferred source: same-product siblings with a Color attribute.
                // For properly-grouped products (e.g. Fujiwa Bohol Hills/Lake, Joya
                // Verde/Albi/Gold/Cotto), each color is its own SKU sharing the
                // same product_id. We pick one representative SKU per distinct
                // color (preferring one that matches the current Size if present)
                // so the swatch row doesn't duplicate when a product has both
                // Color × Size dimensions.
                //
                // Fallback: collection siblings, but ONLY when they clearly
                // represent the same base product (Roman-numeral variants like
                // James Martin, or a single shared name), never when collection
                // is a broad category like "Pool Tile" with 64 unrelated series.
                // Normalize color values: strip embedded dimensions (e.g. "Praia Carrara 12x24" → "Praia Carrara"),
                // thickness specs (9mm, 30mil), and leading dashes from scraper artifacts
                const normColor = (v) => (v || '')
                  .replace(/\s*\d+\.?\d*\s*[xX]+\s*\d+\.?\d*\s*/g, ' ')  // 12x24, 8.98x48.03
                  .replace(/\s*-?\s*\d+m[mi]l?\b/gi, '')                  // 9mm, 30mil
                  .replace(/^\s*-\s*/, '')                                  // leading "- "
                  .replace(/\s+/g, ' ')
                  .trim();

                let colorItems = [];
                const currentColorVal = currentAttrs['color'];
                const currentSizeVal = currentAttrs['size'];
                const normalizedCurrentColor = normColor(currentColorVal);

                const distinctSiblingColors = new Set(
                  mainSiblings
                    .map(s => (s.attributes || []).find(a => a.slug === 'color'))
                    .filter(Boolean)
                    .map(a => normColor(a.value))
                );

                // Check if multiple truly distinct colors exist after normalizing out dimensions
                const allNormalizedColors = new Set(
                  normalizedCurrentColor ? [normalizedCurrentColor, ...distinctSiblingColors] : [...distinctSiblingColors]
                );

                if (normalizedCurrentColor && allNormalizedColors.size > 1) {
                  // Multiple distinct colors within same product — group by normalized color
                  const byColor = new Map();
                  byColor.set(normalizedCurrentColor, {
                    sku_id: sku.sku_id,
                    product_name: normalizedCurrentColor,
                    primary_image: (media && media[0]) ? media[0].url : null,
                    is_current: true,
                  });
                  mainSiblings.forEach(s => {
                    const attrs = (s.attributes || []);
                    const ca = attrs.find(a => a.slug === 'color');
                    const sa = attrs.find(a => a.slug === 'size');
                    if (!ca) return;
                    const color = normColor(ca.value);
                    if (color === normalizedCurrentColor) return;
                    const existing = byColor.get(color);
                    // Prefer a sibling whose Size matches the current SKU's Size
                    const matchesCurrentSize = sa && sa.value === currentSizeVal;
                    if (!existing || (matchesCurrentSize && !existing._sizeMatched)) {
                      byColor.set(color, {
                        sku_id: s.sku_id,
                        product_name: color,
                        primary_image: getVariantImage(s),
                        is_current: false,
                        _sizeMatched: !!matchesCurrentSize,
                      });
                    }
                  });
                  colorItems = [...byColor.values()].sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));
                }

                // Size pills from collection siblings (vanities where sizes are separate products)
                // Computed BEFORE the merge so we can skip merging sizes into colorItems
                const _isDecorativeHW = (sku.vendor_code || '').toUpperCase() === 'ROM440';
                let collectionSizeItems = [];
                if (collectionSiblings.length > 0) {
                  const extractDims = (name) => {
                    const m = (name || '').match(/(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/);
                    if (m) return m[0];
                    const s = (name || '').match(/\b(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*["″]/);
                    return s ? s[0] : null;
                  };
                  const extractFinish = (name) => {
                    const m = (name || '').match(/,\s*(.+?)(?:\s*\(|$)/);
                    return m ? m[1].trim() : null;
                  };
                  const extractSort = (sz) => { const n = parseFractionalInches(sz); if (!isNaN(n)) return n; const m = (sz || '').match(/(\d+)/); return m ? parseFloat(m[1]) : 0; };

                  // Build a lookup of all size+finish combos → sku_id
                  const curSz = extractDims(sku.product_name);
                  const curFinishVal = extractFinish(sku.product_name);
                  const allItems = [{ product_name: sku.product_name, sku_id: sku.sku_id, primary_image: media && media[0] ? media[0].url : null }, ...collectionSiblings];
                  const comboMap = new Map(); // "size|finish" → sku_id
                  const imgMap = new Map(); // sku_id → primary_image
                  allItems.forEach(s => {
                    const sz = extractDims(s.product_name);
                    const fn = extractFinish(s.product_name);
                    if (sz && fn) comboMap.set(sz + '|' + fn, s.sku_id);
                    if (s.primary_image) imgMap.set(s.sku_id, s.primary_image);
                  });

                  if (curSz) {
                    const sizeMap = new Map();
                    allItems.forEach(s => {
                      const sz = extractDims(s.product_name);
                      if (!sz) return;
                      const nk = normalizeSize(sz);
                      if (sizeMap.has(nk)) return;
                      // For this size, prefer same finish as current; fall back to any
                      const target = comboMap.get(sz + '|' + curFinishVal) || s.sku_id;
                      sizeMap.set(nk, { label: formatSizeDim(sz), sku_id: target, is_current: normalizeSize(sz) === normalizeSize(curSz), sort: extractSort(sz), primary_image: imgMap.get(target) || s.primary_image || null });
                    });
                    if (sizeMap.size > 1) {
                      collectionSizeItems = [...sizeMap.values()].sort((a, b) => a.sort - b.sort);
                    }
                  }
                }
                const showSizePills = collectionSizeItems.length > 0;

                // Finish pills from collection siblings
                let collectionFinishItems = [];
                if (collectionSiblings.length > 0) {
                  const extractDims2 = (name) => { const m = (name || '').match(/(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/); return m ? m[0] : null; };
                  const extractFinish2 = (name) => { const m = (name || '').match(/,\s*(.+?)(?:\s*\(|$)/); return m ? m[1].trim() : null; };
                  const curSz2 = extractDims2(sku.product_name);
                  const curFn = extractFinish2(sku.product_name);
                  const allItems2 = [{ product_name: sku.product_name, sku_id: sku.sku_id }, ...collectionSiblings];
                  const comboMap2 = new Map();
                  allItems2.forEach(s => {
                    const sz = extractDims2(s.product_name);
                    const fn = extractFinish2(s.product_name);
                    if (sz && fn) comboMap2.set(sz + '|' + fn, s.sku_id);
                  });
                  if (curFn) {
                    const finishMap = new Map();
                    allItems2.forEach(s => {
                      const fn = extractFinish2(s.product_name);
                      if (!fn || finishMap.has(fn)) return;
                      const target = comboMap2.get(curSz2 + '|' + fn) || s.sku_id;
                      finishMap.set(fn, { label: fn, sku_id: target, is_current: fn === curFn });
                    });
                    if (finishMap.size > 1) {
                      collectionFinishItems = [...finishMap.values()];
                    }
                  }
                }
                // Augment collectionFinishItems with collection-wide finishes not yet present
                if (collectionAttributes.finish && (collectionAttributes.finish.values || []).length >= 2 && collectionSiblings.length > 0) {
                  const existingFinishes = new Set(collectionFinishItems.map(f => f.label));
                  const curSize = currentAttrs['size'] || '';
                  const curFinish2 = currentAttrs['finish'] || '';
                  if (curFinish2 && !existingFinishes.has(curFinish2)) {
                    collectionFinishItems.push({ label: curFinish2, sku_id: sku.sku_id, is_current: true });
                    existingFinishes.add(curFinish2);
                  }
                  (collectionAttributes.finish.values || []).forEach(fn => {
                    if (existingFinishes.has(fn)) return;
                    // Check same-product siblings first (e.g. Tasman has 24x48 Tech Polished)
                    const sameProductMatch = mainSiblings.find(s => {
                      const fAttr = (s.attributes || []).find(a => a.slug === 'finish');
                      return fAttr && fAttr.value === fn;
                    });
                    if (sameProductMatch) {
                      collectionFinishItems.push({ label: fn, sku_id: sameProductMatch.sku_id, is_current: false });
                      return;
                    }
                    // Fall back to collection siblings (cross-product)
                    let targetSkuId = null;
                    for (const cs of collectionSiblings) {
                      if (!cs.sku_map) continue;
                      for (const [key, sid] of Object.entries(cs.sku_map)) {
                        const parts = key.split('|');
                        if (parts[1] !== fn) continue;
                        if (curSize && normalizeSize(parts[0]) === normalizeSize(curSize)) { targetSkuId = sid; break; }
                        if (!targetSkuId) targetSkuId = sid;
                      }
                      if (targetSkuId) break;
                    }
                    if (targetSkuId) {
                      collectionFinishItems.push({ label: fn, sku_id: targetSkuId, is_current: false, is_cross_product: true });
                    }
                  });
                }
                const _hasCountertopFinish = (sku.attributes || []).some(a => a.slug === 'countertop_finish') || allSiblings.some(s => (s.attributes || []).some(a => a.slug === 'countertop_finish'));
                const showFinishPills = collectionFinishItems.length > 0 && !_isDecorativeHW && !_hasCountertopFinish;

                // Width-based size + color from same-product siblings (mirrors, bath accessories)
                let sibSizeItems = [];
                if (mainSiblings.length > 0 && !showSizePills) {
                  const _getWidthRaw = (attrs) => { const ol = (attrs || []).find(a => a.slug === 'overall_length'); if (ol) return ol.value; const wa = (attrs || []).find(a => a.slug === 'width'); return wa ? wa.value : null; };
                  const _getWidthNum = (attrs, vn) => { const raw = _getWidthRaw(attrs); if (raw) return parseFractionalInches(raw); const m = (vn || '').match(/\b(\d+(?:[-\s]\d+\/\d+)?\.?\d*)\s*["″]/); return m ? parseFractionalInches(m[1]) : null; };
                  const _getSize = (attrs) => { const sa = (attrs || []).find(a => a.slug === 'size'); return sa ? sa.value : null; };
                  const _extractColor = (attrs, vn) => { const idx = (vn || '').lastIndexOf(','); if (idx > 0) return vn.substring(idx + 1).trim(); const ca = (attrs || []).find(a => a.slug === 'color'); if (ca) return ca.value; return null; };
                  const curW = _getWidthNum(sku.attributes, sku.variant_name);
                  const curWRaw = _getWidthRaw(sku.attributes);
                  const curC = _extractColor(sku.attributes, sku.variant_name);
                  const curSz = _getSize(sku.attributes);
                  const dimItems = [{ sku_id: sku.sku_id, w: curW, wRaw: curWRaw, sz: curSz, c: curC, img: media && media[0] ? media[0].url : null, is_current: true }];
                  mainSiblings.forEach(s => { dimItems.push({ sku_id: s.sku_id, w: _getWidthNum(s.attributes, s.variant_name), wRaw: _getWidthRaw(s.attributes), sz: _getSize(s.attributes), c: _extractColor(s.attributes, s.variant_name), img: getVariantImage(s), is_current: false }); });
                  const uniqueWidths = new Set(dimItems.filter(d => d.w != null && !isNaN(d.w)).map(d => d.w));
                  if (uniqueWidths.size > 1 && curW != null) {
                    const sizeMap = new Map();
                    dimItems.forEach(d => { if (d.w == null || isNaN(d.w)) return; const ex = sizeMap.get(d.w); if (!ex || d.is_current || (!ex.is_current && d.c === curC && !ex._cm)) { sizeMap.set(d.w, { ...d, _cm: d.c === curC }); } });
                    sibSizeItems = [...sizeMap.values()].map(d => ({ label: d.sz ? formatSizeDim(d.sz) : (d.wRaw || d.w + '\u2033'), sku_id: d.sku_id, is_current: d.w === curW, sort: d.w, primary_image: d.img })).sort((a, b) => a.sort - b.sort);
                    if (colorItems.length > 0) {
                      const availableAtWidth = new Set(dimItems.filter(d => d.w === curW && d.c).map(d => normColor(d.c)));
                      colorItems = colorItems.filter(c => c.is_current || availableAtWidth.has(normColor(c.product_name)));
                      colorItems = colorItems.map(c => { if (c.is_current) return c; const match = dimItems.find(d => d.w === curW && normColor(d.c) === normColor(c.product_name)); return match ? { ...c, sku_id: match.sku_id, primary_image: match.img || c.primary_image } : c; });
                      if (colorItems.length <= 1) { colorItems = []; var _widthCleared = true; }
                    }
                  }
                  const _hasColorAttr = (sku.attributes || []).some(a => a.slug === 'color');
                  if (colorItems.length === 0 && curC && uniqueWidths.size >= 1 && (_widthCleared || !_hasColorAttr)) {
                    const forColors = sibSizeItems.length > 0 && curW ? dimItems.filter(d => d.w === curW) : dimItems;
                    const colorMap = new Map();
                    forColors.forEach(d => { if (d.c && !colorMap.has(d.c)) { colorMap.set(d.c, { sku_id: d.sku_id, product_name: d.c, primary_image: d.img, is_current: d.is_current }); } });
                    if (colorMap.size > 1) { colorItems = [...colorMap.values()].sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '')); }
                  }
                }
                const showSibSizes = sibSizeItems.length > 0;

                // Size pills from size attribute (tile vendors like Roca: Arena 12X24, Arena 24X48)
                let attrSizeItems = [];
                if (!showSizePills && sibSizeItems.length === 0 && mainSiblings.length > 0) {
                  const _getSizeAttr = (attrs) => { const sa = (attrs || []).find(a => a.slug === 'size'); return sa ? sa.value : null; };
                  const curSizeVal = _getSizeAttr(sku.attributes);
                  const dimRe = /(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/;
                  if (curSizeVal && dimRe.test(curSizeVal)) {
                    const sizeMap = new Map();
                    sizeMap.set(normalizeSize(curSizeVal), { label: formatSizeDim(curSizeVal), sku_id: sku.sku_id, is_current: true, sort: parseFractionalInches(curSizeVal.match(dimRe)[1]) });
                    mainSiblings.forEach(s => {
                      if (s.variant_type === 'accessory') return;
                      const sv = _getSizeAttr(s.attributes);
                      if (!sv) return;
                      const nk = normalizeSize(sv);
                      if (sizeMap.has(nk)) return;
                      const dm = sv.match(dimRe);
                      if (!dm) return;
                      sizeMap.set(nk, { label: formatSizeDim(sv), sku_id: s.sku_id, is_current: normalizeSize(sv) === normalizeSize(curSizeVal), sort: parseFractionalInches(dm[1]) });
                    });
                    if (sizeMap.size >= 2) {
                      attrSizeItems = [...sizeMap.values()].sort((a, b) => a.sort - b.sort);
                    }
                  }
                }
                // Augment with collection-wide sizes for consistent pills across the collection
                if (!showSizePills && sibSizeItems.length === 0 && collectionAttributes.size && (collectionAttributes.size.values || []).length >= 2) {
                  const _csa = (attrs) => { const sa = (attrs || []).find(a => a.slug === 'size'); return sa ? sa.value : null; };
                  let curSz = _csa(sku.attributes);
                  const _dimRe = /(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/;
                  // Infer current size from variant_name when attribute is missing
                  if (!curSz) {
                    const vnMatch = (sku.variant_name || '').match(_dimRe);
                    if (vnMatch) {
                      // Find the full collection_attributes size value that contains this dimension
                      const vnNorm = normalizeSize(vnMatch[0]);
                      const fullVal = (collectionAttributes.size.values || []).find(sv => normalizeSize(sv).startsWith(vnNorm));
                      curSz = fullVal || vnMatch[0];
                    }
                  }
                  if (curSz) {
                    const sizeMap = new Map();
                    // Seed from existing attrSizeItems if already built from same-product siblings
                    if (attrSizeItems.length > 0) {
                      attrSizeItems.forEach(item => { sizeMap.set(normalizeSize(item.label.replace(/[″″"]/g, '').replace(/\s*×\s*/g, 'x').trim()), item); });
                    } else {
                      const dm = curSz.match(_dimRe);
                      if (dm) sizeMap.set(normalizeSize(curSz), { label: formatSizeDim(curSz), sku_id: sku.sku_id, is_current: true, sort: parseFractionalInches(dm[1]) });
                      mainSiblings.forEach(s => {
                        if (s.variant_type === 'accessory') return;
                        const sv = _csa(s.attributes);
                        if (!sv) return;
                        const nk = normalizeSize(sv);
                        if (sizeMap.has(nk)) return;
                        const dm2 = sv.match(_dimRe);
                        if (!dm2) return;
                        sizeMap.set(nk, { label: formatSizeDim(sv), sku_id: s.sku_id, is_current: false, sort: parseFractionalInches(dm2[1]) });
                      });
                    }
                    const curFinish = currentAttrs['finish'] || '';
                    (collectionAttributes.size.values || []).forEach(sv => {
                      const nk = normalizeSize(sv);
                      if (sizeMap.has(nk)) return;
                      const dm = sv.match(_dimRe);
                      if (!dm) return;
                      let targetSkuId = null;
                      for (const cs of collectionSiblings) {
                        if (!cs.sku_map) continue;
                        for (const [key, sid] of Object.entries(cs.sku_map)) {
                          const parts = key.split('|');
                          if (normalizeSize(parts[0]) === nk) {
                            if (curFinish && parts[1] === curFinish) { targetSkuId = sid; break; }
                            if (!targetSkuId) targetSkuId = sid;
                          }
                        }
                        if (targetSkuId) break;
                      }
                      if (targetSkuId) sizeMap.set(nk, { label: formatSizeDim(sv), sku_id: targetSkuId, is_current: false, is_cross_product: true, sort: parseFractionalInches(dm[1]) });
                    });
                    if (sizeMap.size >= 2) {
                      attrSizeItems = [...sizeMap.values()].sort((a, b) => a.sort - b.sort);
                    }
                  }
                }
                const showAttrSizes = attrSizeItems.length > 0;

                // If same-product siblings have 0-1 colors, use collection siblings as color options
                if (colorItems.length <= 1 && collectionSiblings.length > 0) {
                  // Exclude accessory/trim siblings from color variant display
                  const nonAccSiblings = collectionSiblings.filter(s => s.variant_type !== 'accessory');
                  if (nonAccSiblings.length > 0) {
                    colorItems = [
                      { sku_id: sku.sku_id, product_name: sku.product_name, variant_name: sku.variant_name, color: currentColorVal, primary_image: (media && media[0]) ? media[0].url : null, is_current: true },
                      ...nonAccSiblings
                    ].sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));
                  }
                }
                // Build attrMap from current product's siblings only (not collection-wide)
                // Collection-wide values caused disabled/dashed pills for sizes only
                // available in other colors, cluttering the UI with unselectable options
                const attrMap = {};
                allSiblings.forEach(s => {
                  (s.attributes || []).forEach(a => {
                    if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: new Set() };
                    attrMap[a.slug].values.add(a.value);
                  });
                });
                // If some siblings have countertop_finish and others don't, add "No Countertop" option
                const _hasNoCtSibling = attrMap['countertop_finish'] && allSiblings.some(s => !(s.attributes || []).some(a => a.slug === 'countertop_finish'));
                if (_hasNoCtSibling) {
                  attrMap['countertop_finish'].values.add('No Countertop');
                  if (!currentAttrs['countertop_finish']) currentAttrs['countertop_finish'] = 'No Countertop';
                }
                const NON_SELECTABLE = new Set(['pei_rating', 'shade_variation', 'water_absorption', 'dcof', 'material', 'material_class', 'country', 'application', 'edge', 'look', 'color', 'color_code', 'style_code', 'price_list', 'companion_skus', 'species', 'subcategory', 'upc', 'msrp', 'weight', 'top_ref_sku', 'sink_ref_sku', 'optional_accessories', 'group_number', 'width', 'size', 'height', 'depth', 'hardware_finish', 'num_drawers', 'num_doors', 'num_shelves', 'num_sinks', 'soft_close', 'sink_material', 'sink_type', 'vanity_type', 'bowl_shape', 'style', 'origin', 'countertop_material', 'construction', 'sub_line', 'collection', 'brand', 'surface_texture', 'wear_layer', 'ac_rating', 'edge_treatment', 'plank_width', 'plank_length', 'composition', 'install_method', 'features', 'technology', 'product_line', 'color_family', 'breaking_strength', 'mohs_hardness', 'color_generic', 'pattern', 'projection', 'clearance', 'overall_length', 'diameter', 'center_to_center']);

                // --- Sub-Line format selector (ADURA Max/Rigid/Flex/APEX) ---
                const curSubLineAttr = (sku.attributes || []).find(a => a.slug === 'sub_line');
                const curSubLine = curSubLineAttr ? curSubLineAttr.value : '';
                const subLineMap = new Map(); // sub_line value → array of sibling entries
                allSiblings.forEach(s => {
                  const sla = (s.attributes || []).find(a => a.slug === 'sub_line');
                  const sl = sla ? sla.value : '';
                  if (sl) {
                    if (!subLineMap.has(sl)) subLineMap.set(sl, []);
                    subLineMap.set(sl, [...subLineMap.get(sl), s]);
                  }
                });
                const subLineValues = [...subLineMap.keys()].sort();
                const showSubLinePill = subLineValues.length > 1;
                // Detect Roman numeral sub-lines (I, II, III) vs ADURA-style (Max, Rigid, etc.)
                const isRomanSubLine = showSubLinePill && subLineValues.every(sl => /^I{1,3}$/.test(sl));
                const subLineSectionLabel = isRomanSubLine ? 'Series' : 'Format';
                // Format sub-line label: "ADURA Max" → "Max", get thickness if available
                const subLineLabel = (sl) => {
                  if (isRomanSubLine) return sl; // "I", "II", "III" as-is
                  const short = sl.replace(/^ADURA\s*/i, '');
                  const rep = (subLineMap.get(sl) || [])[0];
                  if (rep) {
                    const thAttr = (rep.attributes || []).find(a => a.slug === 'thickness');
                    if (thAttr) return short + ' (' + thAttr.value + ')';
                  }
                  return short;
                };
                // When sub-line pill is active, filter color items to only show colors in the current sub-line
                if (showSubLinePill && curSubLine && colorItems.length > 0) {
                  const subLineSibIds = new Set((subLineMap.get(curSubLine) || []).map(s => s.sku_id));
                  subLineSibIds.add(sku.sku_id); // always include current
                  colorItems = colorItems.filter(c => subLineSibIds.has(c.sku_id));
                }
                // When sub-line is active, restrict attribute selectors to current sub-line's SKUs only
                const effectiveSiblings = showSubLinePill && curSubLine
                  ? allSiblings.filter(s => {
                      const sla = (s.attributes || []).find(a => a.slug === 'sub_line');
                      return !sla || sla.value === curSubLine;
                    })
                  : allSiblings;
                // Rebuild attrMap values from effective siblings when sub-line is active
                if (showSubLinePill && curSubLine) {
                  Object.keys(attrMap).forEach(slug => { attrMap[slug].values = new Set(); });
                  effectiveSiblings.forEach(s => {
                    (s.attributes || []).forEach(a => {
                      if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: new Set() };
                      attrMap[a.slug].values.add(a.value);
                    });
                  });
                }

                // Augment attrMap with collection-wide attribute values for consistent pills across colors
                const collectionAugmentedSlugs = new Set();
                if (collectionSiblings.length > 0 && Object.keys(collectionAttributes).length > 0) {
                  Object.entries(collectionAttributes).forEach(([slug, ca]) => {
                    if (!ca || !ca.values || ca.values.length < 2) return;
                    if (NON_SELECTABLE.has(slug) || slug === 'color') return;
                    if (!attrMap[slug]) attrMap[slug] = { name: ca.name, values: new Set() };
                    if (currentAttrs[slug]) attrMap[slug].values.add(currentAttrs[slug]);
                    const localCount = attrMap[slug].values.size;
                    ca.values.forEach(v => attrMap[slug].values.add(v));
                    if (attrMap[slug].values.size > localCount) collectionAugmentedSlugs.add(slug);
                  });
                }

                // --- Extract format qualifiers (Paver, Mosaic, Trim, etc.) from size values ---
                const FORMAT_QUALIFIERS = [
                  { pattern: /\bPaver\b/i, label: 'Paver' },
                  { pattern: /\bMosaic\b/i, label: 'Mosaic' },
                  { pattern: /\bTRIM\b/i, label: 'Trim' },
                  { pattern: /\bLINER\b/i, label: 'Liner' },
                  { pattern: /\bDeco\b/i, label: 'Deco' },
                ];
                // Check if size values across siblings contain mixed formats
                const sizeValues = new Set();
                effectiveSiblings.forEach(s => {
                  const sa = (s.attributes || []).find(a => a.slug === 'size');
                  if (sa) sizeValues.add(sa.value);
                });
                // Detect which formats exist in this product's size values
                const formatSet = new Set();
                let hasStandard = false;
                sizeValues.forEach(val => {
                  const matched = FORMAT_QUALIFIERS.find(q => q.pattern.test(val));
                  if (matched) formatSet.add(matched.label);
                  else hasStandard = true;
                });
                // Only create virtual format pill if product has both standard + qualified OR multiple formats
                const hasFormatPill = formatSet.size > 0 && (hasStandard || formatSet.size > 1);
                // Determine current SKU's format
                const currentSizeRaw = currentAttrs['size'] || '';
                const currentFormatMatch = FORMAT_QUALIFIERS.find(q => q.pattern.test(currentSizeRaw));
                const currentFormat = currentFormatMatch ? currentFormatMatch.label : (hasFormatPill ? 'Standard' : null);
                // Build format values list
                const formatValues = hasFormatPill ? [
                  ...(hasStandard ? ['Standard'] : []),
                  ...[...formatSet].sort()
                ] : [];

                // Only show pills when this color/product actually has multiple options
                const localAttrCounts = {};
                effectiveSiblings.forEach(s => {
                  (s.attributes || []).forEach(a => {
                    if (!localAttrCounts[a.slug]) localAttrCounts[a.slug] = new Set();
                    localAttrCounts[a.slug].add(a.value);
                  });
                  if (_hasNoCtSibling && !(s.attributes || []).some(a => a.slug === 'countertop_finish')) {
                    if (!localAttrCounts['countertop_finish']) localAttrCounts['countertop_finish'] = new Set();
                    localAttrCounts['countertop_finish'].add('No Countertop');
                  }
                });
                // Add collection-augmented values to localAttrCounts so pills appear
                collectionAugmentedSlugs.forEach(slug => {
                  if (!localAttrCounts[slug]) localAttrCounts[slug] = new Set();
                  const ca = collectionAttributes[slug];
                  if (ca && ca.values) ca.values.forEach(v => localAttrCounts[slug].add(v));
                });
                // Check if attribute varies WITHIN a color (not just across colors)
                const colorAttrValues = {};
                effectiveSiblings.forEach(s => {
                  const ca = (s.attributes || []).find(a => a.slug === 'color');
                  const c = (ca && ca.value) || s.variant_name || '';
                  (s.attributes || []).forEach(a => {
                    if (!colorAttrValues[a.slug]) colorAttrValues[a.slug] = {};
                    if (!colorAttrValues[a.slug][c]) colorAttrValues[a.slug][c] = new Set();
                    colorAttrValues[a.slug][c].add(a.value);
                  });
                  if (_hasNoCtSibling && !(s.attributes || []).some(a => a.slug === 'countertop_finish')) {
                    if (!colorAttrValues['countertop_finish']) colorAttrValues['countertop_finish'] = {};
                    if (!colorAttrValues['countertop_finish'][c]) colorAttrValues['countertop_finish'][c] = new Set();
                    colorAttrValues['countertop_finish'][c].add('No Countertop');
                  }
                });
                const variesWithinColor = (slug) => {
                  const byColor = colorAttrValues[slug];
                  if (!byColor) return false;
                  return Object.values(byColor).some(vals => vals.size > 1);
                };
                const _finishIsColor = !!attrMap['countertop_finish'];
                const attrSlugs = _isDecorativeHW ? [] : Object.keys(attrMap).filter(slug => localAttrCounts[slug] && (localAttrCounts[slug].size > 1 || slug === 'countertop_finish') && !NON_SELECTABLE.has(slug) && !(slug === 'finish' && (showFinishPills || _finishIsColor)) && (slug === 'countertop_finish' || collectionAugmentedSlugs.has(slug) || (localAttrCounts[slug].size > 1 ? variesWithinColor(slug) : true)))
                  .sort((a, b) => a === 'finish' ? -1 : b === 'finish' ? 1 : 0);
                const sizeSort = (a, b) => { const na = parseFractionalInches(a), nb = parseFractionalInches(b); if (!isNaN(na) && !isNaN(nb)) return na - nb; return a.localeCompare(b); };
                const showColors = colorItems.length >= 2;
                const isRomanVariants = showColors && colorItems.some(c => hasRomanSuffix(c.product_name));

                // Build separate roman numeral style pills from collection siblings
                // when colors already exist (carpet with both colors AND roman variants like I/II/III)
                let romanStyleItems = [];
                if (colorItems.length >= 2 && !isRomanVariants && collectionSiblings.length > 0) {
                  const curBase = (sku.product_name || '').replace(ROMAN_REGEX, '').replace(/\s+\d+\s*$/, '').trim();
                  const romanSibs = collectionSiblings.filter(s => {
                    const sibBase = (s.product_name || '').replace(ROMAN_REGEX, '').replace(/\s+\d+\s*$/, '').trim();
                    return sibBase === curBase && (hasRomanSuffix(s.product_name) || s.product_name !== sku.product_name);
                  });
                  if (romanSibs.length > 0 && (hasRomanSuffix(sku.product_name) || romanSibs.some(s => hasRomanSuffix(s.product_name)))) {
                    // Deduplicate by product_name (keep first per name, prefer matching current color)
                    const byName = new Map();
                    byName.set(sku.product_name, { sku_id: sku.sku_id, product_name: sku.product_name, is_current: true });
                    romanSibs.forEach(s => {
                      if (!byName.has(s.product_name)) {
                        byName.set(s.product_name, { sku_id: s.sku_id, product_name: s.product_name, is_current: false });
                      }
                    });
                    romanStyleItems = [...byName.values()];
                  }
                }
                const showRomanStylePills = romanStyleItems.length >= 2;

                const colorLabel = attrMap['countertop_finish'] ? 'Cabinet Color' : isRomanVariants ? 'Style' : 'Color';
                const showAttrs = attrSlugs.length > 0;
                // Check if the currently selected size/finish is available for a color swatch
                const isColorCompatible = (c) => {
                  if (c.is_current) return true;
                  const curSize = currentAttrs['size'];
                  // Quick exit: nothing selected to conflict with
                  if (!curSize && attrSlugs.every(s => !currentAttrs[s])) return true;
                  // Collection siblings have available_sizes/available_finishes from API
                  if (c.available_sizes || c.available_finishes) {
                    const sizeOk = !curSize || !c.available_sizes || c.available_sizes.some(s => normalizeSize(s) === normalizeSize(curSize));
                    const finishOk = _finishIsColor || !currentAttrs['finish'] || !c.available_finishes || c.available_finishes.includes(currentAttrs['finish']);
                    return sizeOk && finishOk;
                  }
                  // Same-product color items: check effectiveSiblings
                  const targetColor = c.color || c.product_name;
                  const sameColorSibs = effectiveSiblings.filter(s => {
                    const ca = (s.attributes || []).find(a => a.slug === 'color');
                    return ca && normColor(ca.value) === normColor(targetColor);
                  });
                  if (sameColorSibs.length === 0) return true;
                  // Check size compatibility
                  const sizeOk = !curSize || sameColorSibs.some(s => {
                    const sa = (s.attributes || []).find(a => a.slug === 'size');
                    return sa && normalizeSize(sa.value) === normalizeSize(curSize);
                  });
                  if (!sizeOk) return false;
                  // Check all selectable attributes (finish, shape, countertop, etc.)
                  return attrSlugs.every(attrSlug => {
                    const curVal = currentAttrs[attrSlug];
                    if (!curVal) return true;
                    // Skip finish check in vanity context — finish = cabinet color, changes with color
                    if (attrSlug === 'finish' && _finishIsColor) return true;
                    return sameColorSibs.some(s => {
                      const a = (s.attributes || []).find(a => a.slug === attrSlug);
                      if (curVal === 'No Countertop' && attrSlug === 'countertop_finish') return !a;
                      return a && a.value === curVal;
                    });
                  });
                };
                const showFormatSiblings = formatSiblings.length > 0 && formatLabel;
                if (!showColors && !showAttrs && !hasFormatPill && !showSubLinePill && !showRomanStylePills && !showSizePills && !showFinishPills && !showSibSizes && !showAttrSizes && !showFormatSiblings) return null;
                return (
                  <div className="variant-selectors">
                    {showFormatSiblings && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Style<span>{formatLabel}</span></div>
                        <div className="attr-pills">
                          <button className="attr-pill active">{formatLabel}</button>
                          {formatSiblings.map(fs => (
                            <button key={fs.sku_id} className="attr-pill" onClick={() => onSkuClick(fs.sku_id)}>
                              {fs.format_label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {showColors && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">{colorLabel}<span>{(() => { const cur = colorItems.find(c => c.is_current); return cur ? (isRomanVariants ? romanPillLabel(cur.product_name) : (cur.color || cur.variant_name || cur.product_name)) : ''; })()}</span></div>
                        <div className="color-swatches">
                          {(isRomanVariants ? [...colorItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)) : colorItems).map(c => {
                            const label = isRomanVariants ? romanPillLabel(c.product_name) : (c.color || c.variant_name || c.product_name);
                            const compatible = isColorCompatible(c);
                            return (
                            <div key={c.sku_id} className={'color-swatch-wrap' + (!compatible ? ' limited' : '')} onClick={() => { if (!c.is_current) onSkuClick(c.sku_id); }}>
                              <div className={'color-swatch' + (c.is_current ? ' active' : '') + (!compatible ? ' limited' : '')}>
                                {c.primary_image ? <img onLoad={handleProductImgLoad} src={optimizeImg(c.primary_image, 120)} alt={label} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 600, color: 'var(--stone-500)', textAlign: 'center', lineHeight: 1.2, padding: '4px' }}>{label}</div>}
                              </div>
                              <div className="color-swatch-tooltip">{label}{!compatible ? ' (other options may change)' : ''}</div>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {showSizePills && !attrSlugs.includes('shape') && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Size<span>{collectionSizeItems.find(s => s.is_current)?.label || ''}</span></div>
                        {sku.vendor_code === 'JMV' ? (
                          <div className="color-swatches">
                            {collectionSizeItems.map(s => (
                              <div key={s.label} className="color-swatch-wrap" onClick={() => { if (!s.is_current) onSkuClick(s.sku_id); }}>
                                <div className={'color-swatch' + (s.is_current ? ' active' : '')}>
                                  {s.primary_image ? (
                                    <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 120)} alt={s.label} loading="lazy" decoding="async" width="64" height="64" />
                                  ) : (
                                    <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 600, color: 'var(--stone-500)', textAlign: 'center', lineHeight: 1.2, padding: '4px' }}>{s.label}</div>
                                  )}
                                </div>
                                <div className="color-swatch-tooltip">{s.label}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="attr-pills">
                            {collectionSizeItems.map(s => (
                              <button key={s.label} className={'attr-pill' + (s.is_current ? ' active' : '')} onClick={() => { if (!s.is_current) onSkuClick(s.sku_id); }}>
                                {s.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {showFinishPills && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Finish<span>{collectionFinishItems.find(s => s.is_current)?.label || ''}</span></div>
                        <div className="attr-pills">
                          {collectionFinishItems.map(s => (
                            <button key={s.label} className={'attr-pill' + (s.is_current ? ' active' : '') + (s.is_cross_product ? ' limited' : '')} title={s.is_cross_product ? 'Available in other colors' : ''} onClick={() => { if (!s.is_current && s.sku_id) onSkuClick(s.sku_id); }}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {showSibSizes && !attrSlugs.includes('shape') && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Size<span>{sibSizeItems.find(s => s.is_current)?.label || ''}</span></div>
                        {sku.vendor_code === 'JMV' ? (
                          <div className="color-swatches">
                            {sibSizeItems.map(s => (
                              <div key={s.label} className="color-swatch-wrap" onClick={() => { if (!s.is_current) onSkuClick(s.sku_id); }}>
                                <div className={'color-swatch' + (s.is_current ? ' active' : '')}>
                                  {s.primary_image ? (
                                    <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 120)} alt={s.label} loading="lazy" decoding="async" width="64" height="64" />
                                  ) : (
                                    <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 600, color: 'var(--stone-500)', textAlign: 'center', lineHeight: 1.2, padding: '4px' }}>{s.label}</div>
                                  )}
                                </div>
                                <div className="color-swatch-tooltip">{s.label}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="attr-pills">
                            {sibSizeItems.map(s => (
                              <button key={s.label} className={'attr-pill' + (s.is_current ? ' active' : '')} onClick={() => { if (!s.is_current) onSkuClick(s.sku_id); }}>
                                {s.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {showAttrSizes && !attrSlugs.includes('shape') && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Size<span>{attrSizeItems.find(s => s.is_current)?.label || ''}</span></div>
                        <div className="attr-pills">
                          {attrSizeItems.map(s => (
                            <button key={s.label} className={'attr-pill' + (s.is_current ? ' active' : '') + (s.is_cross_product ? ' limited' : '')} title={s.is_cross_product ? 'Available in other colors' : ''} onClick={() => { if (!s.is_current && s.sku_id) onSkuClick(s.sku_id); }}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {showRomanStylePills && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Style<span>{romanPillLabel(sku.product_name)}</span></div>
                        <div className="attr-pills">
                          {[...romanStyleItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)).map(c => (
                            <button key={c.sku_id} className={'attr-pill' + (c.is_current ? ' active' : '')} onClick={() => { if (!c.is_current) onSkuClick(c.sku_id); }}>
                              {romanPillLabel(c.product_name)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {showSubLinePill && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">{subLineSectionLabel}<span>{curSubLine ? (isRomanSubLine ? curSubLine : curSubLine.replace(/^ADURA\s*/i, '')) : ''}</span></div>
                        <div className="attr-pills">
                          {subLineValues.map(sl => {
                            const isActive = sl === curSubLine;
                            // Find best SKU in this sub-line matching current color, or first available
                            const findSubLineMatch = () => {
                              if (isActive) return null;
                              const candidates = (subLineMap.get(sl) || []).filter(s => s.sku_id !== sku.sku_id);
                              if (candidates.length === 0) return null;
                              // Prefer same color
                              const colorMatch = candidates.find(s => {
                                const ca = (s.attributes || []).find(a => a.slug === 'color');
                                return ca && ca.value === currentColorVal;
                              });
                              return colorMatch || candidates[0];
                            };
                            const best = findSubLineMatch();
                            const isDisabled = !isActive && !best;
                            return (
                              <button key={sl} className={'attr-pill' + (isActive ? ' active' : '') + (isDisabled ? ' disabled' : '')} onClick={() => {
                                if (!isActive && !isDisabled && best) onSkuClick(best.sku_id);
                              }}>
                                {subLineLabel(sl)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* Format pill (Paver, Mosaic, etc.) — virtual attribute extracted from size values */}
                    {hasFormatPill && (
                      <div className="variant-selector-group">
                        <div className="variant-selector-label">Format<span>{currentFormat || ''}</span></div>
                        <div className="attr-pills">
                          {formatValues.map(fmt => {
                            const isActive = fmt === currentFormat;
                            // Find best sibling matching this format
                            const findFormatMatch = () => {
                              if (isActive) return null;
                              const isStd = fmt === 'Standard';
                              const qualifier = !isStd && FORMAT_QUALIFIERS.find(q => q.label === fmt);
                              const candidates = effectiveSiblings.filter(s => {
                                if (s.sku_id === sku.sku_id) return false;
                                const sizeAttr = (s.attributes || []).find(a => a.slug === 'size');
                                if (!sizeAttr) return isStd;
                                const hasQ = qualifier && qualifier.pattern.test(sizeAttr.value);
                                return isStd ? !FORMAT_QUALIFIERS.some(q => q.pattern.test(sizeAttr.value)) : hasQ;
                              });
                              if (candidates.length === 0) return null;
                              if (candidates.length === 1) return candidates[0];
                              // Score by matching other attributes (finish, etc.)
                              const scored = candidates.map(s => {
                                const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                                let score = 0;
                                attrSlugs.forEach(k => { if (k !== 'size') { if (currentAttrs[k] === 'No Countertop' && k === 'countertop_finish') { if (!sa[k]) score++; } else if (sa[k] === currentAttrs[k]) { score++; } } });
                                // Prefer same base size dimension
                                const curBase = currentSizeRaw.replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, '').trim();
                                const sibSize = (sa['size'] || '').replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, '').trim();
                                if (curBase && sibSize && curBase === sibSize) score += 2;
                                return { ...s, score };
                              });
                              return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
                            };
                            const best = findFormatMatch();
                            const isDisabled = !isActive && !best;
                            return (
                              <button key={fmt} className={'attr-pill' + (isActive ? ' active' : '') + (isDisabled ? ' disabled' : '')} onClick={() => {
                                if (!isActive && !isDisabled && best) onSkuClick(best.sku_id);
                              }}>
                                {fmt}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {showAttrs && attrSlugs.map(slug => {
                      // When format pill is active, show cleaned size values (strip qualifier)
                      const rawValues = [...attrMap[slug].values];
                      const allValues = (slug === 'size' && hasFormatPill ? (() => {
                        // Filter sizes to current format, then strip qualifier text for display
                        const isStd = currentFormat === 'Standard';
                        const qualifier = !isStd && FORMAT_QUALIFIERS.find(q => q.label === currentFormat);
                        return rawValues.filter(val => {
                          if (isStd) return !FORMAT_QUALIFIERS.some(q => q.pattern.test(val));
                          return qualifier && qualifier.pattern.test(val);
                        });
                      })() : rawValues).sort(sizeSort);
                      const currentVal = currentAttrs[slug];
                      // Compute which values are compatible with current color, size, AND other selectable attributes
                      const compatibleValues = new Set(allValues.filter(val => {
                        const inProduct = effectiveSiblings.some(s => {
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          if (val === 'No Countertop' && slug === 'countertop_finish') { if (sa[slug]) return false; }
                          else if (sa[slug] !== val) return false;
                          // Must match current color (if any) — color is managed by dedicated section
                          // Exception: finish pills in vanity context switch cabinet color, which inherently changes color
                          if (currentAttrs['color'] && sa['color'] && normColor(sa['color']) !== normColor(currentAttrs['color']) && !(slug === 'finish' && _finishIsColor)) return false;
                          // Must match current size (if any) — size is managed by dedicated section
                          if (currentAttrs['size'] && sa['size'] && normalizeSize(sa['size']) !== normalizeSize(currentAttrs['size'])) return false;
                          // Must match all other selectable attributes
                          return attrSlugs.every(otherSlug => {
                            if (otherSlug === slug) return true;
                            if (currentAttrs[otherSlug] === 'No Countertop' && otherSlug === 'countertop_finish') return !sa[otherSlug];
                            return !currentAttrs[otherSlug] || !sa[otherSlug] || sa[otherSlug] === currentAttrs[otherSlug];
                          });
                        });
                        return inProduct;
                      }));
                      if (allValues.length <= 1 && !currentVal) return null;
                      const _scoreSibling = (sa) => {
                        let score = 0;
                        // Heavily weight color/size matches (managed by dedicated sections, not in attrSlugs)
                        if (currentAttrs['color'] && sa['color'] && normColor(sa['color']) === normColor(currentAttrs['color'])) score += 10;
                        if (currentAttrs['size'] && sa['size'] && normalizeSize(sa['size']) === normalizeSize(currentAttrs['size'])) score += 10;
                        // Score other selectable attribute matches
                        attrSlugs.forEach(k => { if (k !== slug) { if (currentAttrs[k] === 'No Countertop' && k === 'countertop_finish') { if (!sa[k]) score++; } else if (sa[k] === currentAttrs[k]) { score++; } } });
                        return score;
                      };
                      const findBest = (val) => {
                        // Only consider siblings that match the target attribute value
                        const matching = effectiveSiblings.filter(s => {
                          if (s.sku_id === sku.sku_id) return false;
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          if (val === 'No Countertop' && slug === 'countertop_finish') return !sa[slug];
                          return sa[slug] === val;
                        });
                        if (matching.length === 0) return null;
                        if (matching.length === 1) return matching[0];
                        const scored = matching.map(s => {
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          return { ...s, score: _scoreSibling(sa) };
                        });
                        return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
                      };
                      // Relaxed match: find any sibling with this value, ignoring other constraints
                      const findAny = (val) => {
                        const matching = effectiveSiblings.filter(s => {
                          if (s.sku_id === sku.sku_id) return false;
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          if (val === 'No Countertop' && slug === 'countertop_finish') return !sa[slug];
                          return sa[slug] === val;
                        });
                        if (matching.length === 0) return null;
                        const scored = matching.map(s => {
                          const sa = (s.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          return { ...s, score: _scoreSibling(sa) };
                        });
                        return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
                      };
                      // Cross-product fallback: find a SKU in another collection color with this attribute value
                      const findCrossProduct = (val) => {
                        if (!collectionSiblings.length) return null;
                        let bestMatch = null;
                        for (const cs of collectionSiblings) {
                          if (!cs.sku_map) continue;
                          for (const [key, sid] of Object.entries(cs.sku_map)) {
                            const [szVal, fnVal] = key.split('|');
                            const attrMatch = slug === 'finish' ? fnVal === val : false;
                            if (!attrMatch) continue;
                            if (currentAttrs['size'] && normalizeSize(szVal) === normalizeSize(currentAttrs['size'])) return { sku_id: sid };
                            if (!bestMatch) bestMatch = { sku_id: sid };
                          }
                        }
                        return bestMatch;
                      };
                      // Image swatches for visually-distinct attributes where each variant looks different
                      const IMAGE_SWATCH_ATTRS = new Set(['countertop_finish', 'pattern']);
                      // finish gets image swatches only for vanity tops (where it means cabinet color)
                      const useImageSwatches =
                        IMAGE_SWATCH_ATTRS.has(slug) ||
                        (slug === 'finish' && attrMap['countertop_finish']);
                      const getSwatchImage = (val) => {
                        if (val === currentVal) {
                          if (slug === 'countertop_finish' && countertopImage) return countertopImage;
                          return (media && media[0]) ? media[0].url : null;
                        }
                        const match = findBest(val);
                        if (!match) return null;
                        return getVariantImage(match, { preferCountertop: slug === 'countertop_finish' });
                      };
                      // Clean size display: strip format qualifier when format pill is active
                      const displayVal = (val) => {
                        if (slug === 'size' && hasFormatPill) {
                          return formatSizeDim(val.replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, '').trim() || val);
                        }
                        if (slug === 'size') return formatSizeDim(val);
                        return formatCarpetValue(val);
                      };
                      return (
                        <div key={slug} className="variant-selector-group">
                          <div className="variant-selector-label">{slug === 'finish' && attrMap['countertop_finish'] ? 'Cabinet Color' : slug === 'countertop_finish' ? 'Countertop' : attrMap[slug].name}<span>{displayVal(currentVal || '')}</span></div>
                          {useImageSwatches ? (
                            <div className="color-swatches">
                              {allValues.map(val => {
                                const isActive = val === currentVal;
                                const isDisabled = !compatibleValues.has(val);
                                const img = getSwatchImage(val);
                                const best = findBest(val);
                                return (
                                  <div key={val} className={'color-swatch-wrap' + (isDisabled ? ' limited' : '')} onClick={() => { if (!isActive) { const target = best || findAny(val) || findCrossProduct(val); if (target) onSkuClick(target.sku_id); } }}>
                                    <div className={'color-swatch' + (isActive ? ' active' : '') + (isDisabled ? ' limited' : '')}>
                                      {img ? <img onLoad={handleProductImgLoad} src={optimizeImg(img, 120)} alt={displayVal(val)} loading="lazy" decoding="async" width="64" height="64" /> : <div style={{ width: '100%', height: '100%', background: 'var(--stone-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: 'var(--stone-500)', textAlign: 'center', padding: '0.25rem' }}>{displayVal(val)}</div>}
                                    </div>
                                    <div className="color-swatch-tooltip">{displayVal(val)}{isDisabled ? (findCrossProduct(val) ? ' (available in other colors)' : ' (other options may change)') : ''}</div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="attr-pills">
                              {allValues.map(val => {
                                const isActive = val === currentVal;
                                const isDisabled = !compatibleValues.has(val);
                                const best = findBest(val);
                                return (
                                  <button key={val} className={'attr-pill' + (isActive ? ' active' : '') + (isDisabled ? ' limited' : '')} title={isDisabled ? (findCrossProduct(val) ? 'Available in other colors' : 'Other options may change') : ''} onClick={() => { if (!isActive) { const target = best || findAny(val) || findCrossProduct(val); if (target) onSkuClick(target.sku_id); } }}>
                                    {displayVal(val)}
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

              <StockBadge status={sku.stock_status} vendorHasInventory={sku.vendor_has_inventory} qtyOnHand={sku.qty_on_hand} qtyOnHandSqft={sku.qty_on_hand_sqft} sellBy={sku.sell_by} />

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

              {/* Packaging Info (box-based and slab products) */}
              {!isCarpetSku && sqftPerBox > 0 && (
                <div className="packaging-info">
                  <div className="pdp-pkg-cell">
                    <span className="pdp-pkg-cell-label">{isSlabUnit ? 'Slab Size' : 'Coverage'}</span>
                    <span className="pdp-pkg-cell-value">{sqftPerBox} sqft{isSlabUnit ? '' : '/' + boxLabel}</span>
                  </div>
                  {!isSlabUnit && sku.pieces_per_box && (
                    <div className="pdp-pkg-cell">
                      <span className="pdp-pkg-cell-label">Pieces</span>
                      <span className="pdp-pkg-cell-value">{sku.pieces_per_box}/{boxLabel}</span>
                    </div>
                  )}
                  {sku.weight_per_box_lbs && (
                    <div className="pdp-pkg-cell">
                      <span className="pdp-pkg-cell-label">Weight</span>
                      <span className="pdp-pkg-cell-value">{parseFloat(sku.weight_per_box_lbs).toFixed(1)} lbs</span>
                    </div>
                  )}
                  {!isSlabUnit && sku.boxes_per_pallet && (
                    <div className="pdp-pkg-cell">
                      <span className="pdp-pkg-cell-label">Pallet</span>
                      <span className="pdp-pkg-cell-value">{sku.boxes_per_pallet} {boxLabelPlural}{sku.sqft_per_pallet ? ' (' + parseFloat(sku.sqft_per_pallet).toLocaleString() + ' sqft)' : ''}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Roll Specifications (carpet products) */}
              {isCarpetSku && (rollWidthFt > 0 || rollLengthFt > 0 || sku.sqft_per_pallet || sku.weight_per_pallet_lbs) && (
                <div className="carpet-roll-info">
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
              {isCarpetSku && cutPrice > 0 && !isOutOfStock && (
                <div className="calculator-widget">
                  <h3>Carpet Calculator</h3>
                  {rollWidthFt > 0 && (
                    <div className="carpet-roll-width-header">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 20, height: 20 }}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
                      {rollWidthFt}' Wide Roll
                    </div>
                  )}
                  <div className="calc-mode-tabs">
                    {rollWidthFt > 0 && (
                      <button className={'calc-mode-tab' + (carpetInputMode === 'linear' ? ' active' : '')} onClick={() => setCarpetInputMode('linear')}>Linear Feet</button>
                    )}
                    <button className={'calc-mode-tab' + (carpetInputMode === 'dimensions' ? ' active' : '')} onClick={() => setCarpetInputMode('dimensions')}>Room Size</button>
                    <button className={'calc-mode-tab' + (carpetInputMode === 'sqft' ? ' active' : '')} onClick={() => setCarpetInputMode('sqft')}>Enter Sqft</button>
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
                  <button className="pdp-btn pdp-btn-primary" style={{ marginTop: '1.25rem' }}
                    onClick={handleAddToCart} disabled={carpetSqft <= 0 || isOutOfStock}>
                    {isOutOfStock ? 'Out of Stock' : ('Add to Cart ' + (carpetSqft > 0 ? '\u2014 $' + carpetSubtotal.toFixed(2) : ''))}
                  </button>
                </div>
              )}

              {/* Coverage Calculator (sqft-sold products — no box rounding) */}
              {!isCarpetSku && isSoldPerSqft && effectivePrice > 0 && !isOutOfStock && (
                <div className="calculator-widget">
                  <h3>Coverage Calculator</h3>
                  <div className="calc-input-row">
                    <div className="calc-input-group" style={{ flex: 1 }}>
                      <label>Square Feet Needed</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="0"
                        value={sqftInput} onChange={(e) => setSqftInput(e.target.value)} />
                    </div>
                  </div>
                  <label className="carpet-overage-label">
                    <input type="checkbox" checked={includeOverage} onChange={(e) => setIncludeOverage(e.target.checked)} />
                    Add 10% overage for cuts &amp; breakage
                  </label>
                  {sqftCalcAmount > 0 && (
                    <div className="calc-summary">
                      <div className="calc-summary-row"><span>Coverage</span><span>{sqftCalcAmount.toFixed(1)} sqft</span></div>
                      <div className="calc-summary-row"><span>Price</span><span>${effectivePrice.toFixed(2)}/sqft</span></div>
                      <div className="calc-summary-total"><span>Subtotal</span><span>${sqftCalcSubtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  <button className="pdp-btn pdp-btn-primary" style={{ marginTop: '1.25rem' }}
                    onClick={handleAddToCart} disabled={sqftCalcAmount <= 0 || isOutOfStock}>
                    {isOutOfStock ? 'Out of Stock' : ('Add to Cart ' + (sqftCalcAmount > 0 ? '\u2014 $' + sqftCalcSubtotal.toFixed(2) : ''))}
                  </button>
                </div>
              )}

              {/* Coverage Calculator (box-based products) */}
              {!isCarpetSku && hasBoxCalc && effectivePrice > 0 && !isOutOfStock && (
                <div className="calculator-widget">
                  <h3>Coverage Calculator</h3>
                  <div className="calc-input-row">
                    <div className="calc-input-group">
                      <label>Square Feet Needed</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="0"
                        value={sqftInput} onChange={(e) => handleSqftChange(e.target.value)} />
                    </div>
                    <div className="calc-input-group">
                      <label>{isSheetUnit ? 'Sheets' : 'Boxes'}</label>
                      <input className="calc-input" type="number" min="0" step="1" placeholder="0"
                        value={boxesInput} onChange={(e) => handleBoxesChange(e.target.value)} />
                    </div>
                  </div>
                  <label className="carpet-overage-label">
                    <input type="checkbox" checked={includeOverage} onChange={(e) => setIncludeOverage(e.target.checked)} />
                    Add 10% overage for cuts &amp; breakage
                  </label>
                  {numBoxes > 0 && (
                    <div className="calc-summary">
                      <div className="calc-summary-row"><span>{isSheetUnit ? 'Sheets' : 'Boxes'}</span><span>{numBoxes}</span></div>
                      <div className="calc-summary-row"><span>Coverage</span><span>{actualSqft.toFixed(1)} sqft</span></div>
                      {numBoxes > 0 && sku.weight_per_box_lbs && (
                        <div className="calc-summary-row"><span>Est. Weight</span><span>{(numBoxes * parseFloat(sku.weight_per_box_lbs)).toFixed(0)} lbs</span></div>
                      )}
                      <div className="calc-summary-total"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  <button className="pdp-btn pdp-btn-primary" style={{ marginTop: '1.25rem' }}
                    onClick={handleAddToCart} disabled={numBoxes <= 0 || isOutOfStock}>
                    {isOutOfStock ? 'Out of Stock' : ('Add to Cart ' + (numBoxes > 0 ? '\u2014 $' + subtotal.toFixed(2) : ''))}
                  </button>
                </div>
              )}

              {/* Sheet Vinyl Roll Calculator */}
              {isSheetVinyl && effectivePrice > 0 && !isOutOfStock && (
                <div className="calculator-widget">
                  <h3>Roll Calculator</h3>
                  <div className="carpet-roll-width-header">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
                    {sheetRollWidthFt}' Wide Roll
                  </div>
                  <div className="calc-mode-tabs">
                    <button className={'calc-mode-tab' + (carpetInputMode === 'linear' ? ' active' : '')} onClick={() => setCarpetInputMode('linear')}>Linear Feet</button>
                    <button className={'calc-mode-tab' + (carpetInputMode === 'dimensions' ? ' active' : '')} onClick={() => setCarpetInputMode('dimensions')}>Room Size</button>
                    <button className={'calc-mode-tab' + (carpetInputMode === 'sqft' ? ' active' : '')} onClick={() => setCarpetInputMode('sqft')}>Enter Sqft</button>
                  </div>
                  {sheetMode === 'linear' ? (
                    <div className="calc-input-row">
                      <div className="calc-input-group" style={{ flex: 1 }}>
                        <label>Linear Feet Needed</label>
                        <input className="calc-input" type="number" min="0" step="0.5" placeholder="e.g. 50"
                          value={linearFeet} onChange={(e) => setLinearFeet(e.target.value)} />
                      </div>
                    </div>
                  ) : sheetMode === 'dimensions' ? (
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
                    Add 10% overage for seams &amp; waste
                  </label>
                  {sheetNeedsSeam && (
                    <div className="carpet-seam-note">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      Room width ({parseFloat(roomWidth).toFixed(0)}') exceeds roll width ({sheetRollWidthFt}') — a seam will be required
                    </div>
                  )}
                  {sheetSqft > 0 && (
                    <div className="calc-summary">
                      {sheetMode === 'linear' && (
                        <div className="calc-summary-row">
                          <span>Cut Size</span><span>{sheetRollWidthFt} ft &times; {parseFloat(linearFeet).toFixed(1)} ft = {sheetRawSqft.toFixed(1)} sqft</span>
                        </div>
                      )}
                      {includeCarpetOverage && (
                        <div className="calc-summary-row">
                          <span>+ 10% Overage</span><span>{sheetSqft.toFixed(1)} sqft</span>
                        </div>
                      )}
                      {!includeCarpetOverage && sheetMode !== 'linear' && (
                        <div className="calc-summary-row">
                          <span>Area</span><span>{sheetSqft.toFixed(1)} sqft</span>
                        </div>
                      )}
                      <div className="calc-summary-row">
                        <span>Price</span><span>${effectivePrice.toFixed(2)}/sqft</span>
                      </div>
                      <div className="calc-summary-total"><span>Subtotal</span><span>${sheetSubtotal.toFixed(2)}</span></div>
                    </div>
                  )}
                  <button className="pdp-btn pdp-btn-primary" style={{ marginTop: '1.25rem' }}
                    onClick={handleAddToCart} disabled={sheetSqft <= 0 || isOutOfStock}>
                    {isOutOfStock ? 'Out of Stock' : ('Add to Cart ' + (sheetSqft > 0 ? '\u2014 $' + sheetSubtotal.toFixed(2) : ''))}
                  </button>
                </div>
              )}

              {/* Per-unit inquiry (slabs missing size, or no pricing) */}
              {isPerUnit && (slabMissingSize || effectivePrice <= 0) && (
                <div className="unit-add-to-cart">
                  <div style={{ background: 'var(--cream-warm)', border: '0.5px solid rgba(21,18,15,0.07)', borderRadius: 4, padding: '1.5rem', textAlign: 'center' }}>
                    <p style={{ margin: '0 0 0.375rem', fontFamily: 'var(--font-heading)', fontSize: '1.125rem', fontWeight: 300, color: 'var(--stone-900)' }}>Slab — Please Inquire</p>
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--stone-500)', lineHeight: 1.5 }}>
                      Contact us to confirm slab dimensions and availability.
                    </p>
                    <a href="tel:7149990009" className="pdp-btn pdp-btn-ghost" style={{ marginTop: '1rem', textDecoration: 'none' }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                      Call (714) 999-0009
                    </a>
                  </div>
                </div>
              )}
              {isPerUnit && !slabMissingSize && effectivePrice > 0 && !isOutOfStock && (
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
                  <button className="pdp-btn pdp-btn-primary"
                    onClick={handleAddToCart} disabled={unitQty <= 0 || isOutOfStock}>
                    {isOutOfStock ? 'Out of Stock' : (effectivePrice > 0 ? 'Add to Cart \u2014 $' + unitSubtotal.toFixed(2) : 'Add to Cart')}
                  </button>
                </div>
              )}

              {/* Call for Price & Stock — shown when no pricing is available */}
              {!isCarpetSku && !isPerUnit && !isSoldPerSqft && (effectivePrice <= 0 || (sqftPerBox <= 0 && !isSheetVinyl)) && (
                <div style={{ background: 'var(--cream-warm)', border: '0.5px solid rgba(21,18,15,0.07)', borderRadius: 4, padding: '1.5rem', textAlign: 'center' }}>
                  <p style={{ margin: '0 0 0.375rem', fontFamily: 'var(--font-heading)', fontSize: '1.125rem', fontWeight: 300, color: 'var(--stone-900)' }}>Call for Price &amp; Stock</p>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--stone-500)', lineHeight: 1.5 }}>
                    Contact us for current pricing, stock availability, and lead times.
                  </p>
                  <a href="tel:7149990009" className="pdp-btn pdp-btn-ghost" style={{ marginTop: '1rem', textDecoration: 'none' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                    Call (714) 999-0009
                  </a>
                </div>
              )}

              {/* Matching Accessories */}
              {accessorySiblings.length > 0 && (
                <div className="accessories-section-sf">
                  <h3>Matching Accessories</h3>
                  <div className="accessories-subtitle-sf">{/^bath/i.test(sku.category_slug || '') || /vanitie|mirror|cabinet/i.test(sku.category_name || '') ? 'Complete your bathroom with matching pieces' : 'Complete your installation with coordinating trim and transitions'}</div>
                  {accessorySiblings.map(acc => {
                    const accPrice = parseFloat(acc.sale_price || acc.retail_price) || 0;
                    const accQty = accessoryQtys[acc.sku_id] || 1;
                    const accLabel = acc.accessory_label || formatVariantName(acc.variant_name) || 'Accessory';
                    return (
                      <div key={acc.sku_id} className="accessory-card-sf">
                        {acc.primary_image && (
                          <div className="accessory-card-sf-image" style={{ cursor: 'pointer' }} onClick={() => onSkuClick(acc.sku_id, acc.accessory_label || acc.variant_name)}>
                            <img onLoad={handleProductImgLoad} src={optimizeImg(acc.primary_image, 80)} alt={accLabel} width="48" height="48" loading="lazy" decoding="async" />
                          </div>
                        )}
                        <div className="accessory-card-sf-header">
                          <div className="accessory-card-sf-name" style={{ cursor: 'pointer' }} onClick={() => onSkuClick(acc.sku_id, acc.accessory_label || acc.variant_name)}>{accLabel}</div>
                          <div className="accessory-card-sf-price">${accPrice.toFixed(2)} {acc.sell_by === 'box' ? '/sqft' : '/ea'}</div>
                        </div>
                        <div className="accessory-card-sf-actions">
                          <div className="acc-stepper">
                            <button onClick={() => setAccessoryQtys(prev => ({ ...prev, [acc.sku_id]: Math.max(1, (prev[acc.sku_id] || 1) - 1) }))}>&minus;</button>
                            <span>{accQty}</span>
                            <button onClick={() => setAccessoryQtys(prev => ({ ...prev, [acc.sku_id]: (prev[acc.sku_id] || 1) + 1 }))}>+</button>
                          </div>
                          <button className="acc-add-btn" onClick={() => {
                            addToCart({
                              product_id: sku.product_id,
                              sku_id: acc.sku_id,
                              sqft_needed: 0,
                              num_boxes: accQty,
                              include_overage: false,
                              unit_price: accPrice,
                              subtotal: (accQty * accPrice).toFixed(2),
                              sell_by: acc.sell_by || 'unit'
                            });
                          }}>
                            Add ${(accQty * accPrice).toFixed(2)}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Visualize in Your Room — Roomvo enables this button automatically when the SKU is recognized */}
              <button className="pdp-btn pdp-btn-ghost roomvo-visualize-btn"
                ref={el => { try { if (el && window.roomvo) window.roomvo.enableButtonForVisualization(el); } catch(e) {} }}
                data-sku={sku.vendor_sku || sku.internal_sku}
                style={{ visibility: 'hidden' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18 }}>
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                  <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                Visualize in Your Room
              </button>

              {/* Sample CTA */}
              <button className="pdp-btn pdp-btn-ghost" onClick={handleRequestSample}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
                Request Free Sample
              </button>

              {/* Installation CTA */}
              <div className="install-cta">
                <div className="install-cta-text">
                  <div className="install-cta-title">Need professional installation?</div>
                  <div className="install-cta-sub">Free estimates &middot; Licensed &amp; insured installers</div>
                </div>
                <button className="pdp-btn pdp-btn-primary" onClick={() => onRequestInstall(sku)}>Get Quote</button>
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
                <div className="siblings-section" ref={sectionRefs.companions}>
                  <div className="siblings-section-header">
                    <div className="siblings-section-eyebrow">02 &mdash; Complete the Look</div>
                    <h2>Companion Products</h2>
                  </div>
                  {Object.entries(byCategory).map(([catName, items]) => (
                    <div key={catName} style={{ marginBottom: '1.5rem' }}>
                      <div className="sibling-card-meta" style={{ marginBottom: '0.75rem', fontSize: '0.6875rem' }}>{catName}</div>
                      <div className="siblings-strip">
                        {items.map(s => (
                          <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                            <div className="sibling-card-image">
                              {s.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                            </div>
                            <div className="sibling-card-name">{s.product_name}</div>
                            {skuListPrice(s) && <div className="sibling-card-price">from ${displayPrice(s, skuListPrice(s)).toFixed(2)}{priceSuffix(s)}</div>}
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
              <div className="siblings-section" ref={sectionRefs.variants}>
                <div className="siblings-section-header">
                  <div className="siblings-section-eyebrow">03 &mdash; Variants</div>
                  <h2>Other Sizes &amp; Finishes</h2>
                  <div className="siblings-section-sub">Same species, same finish &mdash; different plank dimensions and price points.</div>
                </div>
                <div className="siblings-strip">
                  {mainSiblings.map(s => {
                    const isCurrent = s.sku_id === skuId;
                    return (
                      <div key={s.sku_id} className={'sibling-card' + (isCurrent ? ' is-current' : '')} onClick={() => !isCurrent && onSkuClick(s.sku_id)}>
                        <div className="sibling-card-image">
                          {s.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 400)} alt={formatVariantName(s.variant_name)} loading="lazy" decoding="async" />}
                        </div>
                        <div className="sibling-card-name">{formatCarpetValue(s.variant_name) || 'Variant'}</div>
                        {s.attributes && s.attributes.length > 0 && (() => {
                          const SKIP = new Set(['price_list', 'material_class', 'style_code', 'subcategory', 'upc', 'color', 'color_code', 'collection', 'material', 'companion_skus', 'brand', 'application', 'roll_width', 'roll_length', 'weight_per_sqyd']);
                          const useful = s.attributes.filter(a => !SKIP.has(a.slug));
                          const currentVals = (sku.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
                          const differing = useful.filter(a => currentVals[a.slug] !== a.value);
                          if (differing.length === 0) return null;
                          return <div className="sibling-card-meta">{differing.map(a => formatCarpetValue(a.value)).join(' \u00B7 ')}</div>;
                        })()}
                        <div className="sibling-card-footer">
                          {skuListPrice(s) && <span className="sibling-card-price">${displayPrice(s, skuListPrice(s)).toFixed(2)}{priceSuffix(s)}</span>}
                          <span className="sibling-card-cta">{isCurrent ? 'Current' : 'View \u2192'}</span>
                        </div>
                      </div>
                    );
                  })}
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
                <div className="siblings-section" ref={sectionRefs.collection}>
                  <div className="siblings-section-header">
                    <div className="siblings-section-eyebrow">04 &mdash; Collection</div>
                    <h2>More from <em>{sku.collection}</em></h2>
                  </div>
                  <div className="siblings-strip">
                    {collectionSiblings.map(s => {
                      const isCurrent = s.sku_id === skuId;
                      return (
                        <div key={s.sku_id} className={'sibling-card' + (isCurrent ? ' is-current' : '')} onClick={() => !isCurrent && onSkuClick(s.sku_id)}>
                          <div className="sibling-card-image">
                            {s.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                          </div>
                          <div className="sibling-card-name">{fullProductName(s)}</div>
                          <div className="sibling-card-footer">
                            {skuListPrice(s) && <span className="sibling-card-price">${displayPrice(s, skuListPrice(s)).toFixed(2)}{priceSuffix(s)}</span>}
                            <span className="sibling-card-cta">{isCurrent ? 'Current' : 'View \u2192'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {recentlyViewed && recentlyViewed.filter(r => r.sku_id !== skuId).length > 0 && (
              <div className="siblings-section" ref={sectionRefs.recent}>
                <div className="siblings-section-header">
                  <div className="siblings-section-header-row">
                    <div>
                      <div className="siblings-section-eyebrow">05 &mdash; Recently Viewed</div>
                      <h2>Recently Viewed</h2>
                    </div>
                    <span className="siblings-section-aside">Saved on this device</span>
                  </div>
                </div>
                <div className="siblings-strip">
                  {recentlyViewed.filter(r => r.sku_id !== skuId).slice(0, 8).map(s => (
                    <div key={s.sku_id} className="sibling-card" onClick={() => onSkuClick(s.sku_id)}>
                      <div className="sibling-card-image">
                        {s.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(s.primary_image, 400)} alt={s.product_name} loading="lazy" decoding="async" />}
                      </div>
                      <div className="sibling-card-name">{fullProductName(s)}</div>
                      <div className="sibling-card-footer">
                        {skuListPrice(s) && <span className="sibling-card-price">${displayPrice(s, skuListPrice(s)).toFixed(2)}{priceSuffix(s)}</span>}
                        <span className="sibling-card-cta">View &#8594;</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Customer Reviews */}
            <div className="reviews-section" ref={sectionRefs.reviews}>
              <div className="reviews-grid">
                {/* Left — rating summary + histogram */}
                <div className="reviews-sidebar" ref={reviewsSidebarRef}>
                  <div className="siblings-section-header">
                    <div className="siblings-section-eyebrow">06 &mdash; Reviews</div>
                    <h2>Customer Reviews</h2>
                  </div>
                  {reviewCount > 0 ? (
                    <>
                      <div className="reviews-sidebar-rating">{avgRating.toFixed(1)}<span>/5</span></div>
                      <div className="reviews-sidebar-stars"><StarDisplay rating={avgRating} size={18} /></div>
                      <div className="reviews-sidebar-count">{reviewCount} verified review{reviewCount !== 1 ? 's' : ''}</div>
                      <div className="reviews-dist">
                        {[5,4,3,2,1].map(star => {
                          const count = reviews.filter(r => Math.round(r.rating) === star).length;
                          const pct = reviewCount > 0 ? Math.round((count / reviewCount) * 100) : 0;
                          return (
                            <div key={star} className="reviews-dist-row">
                              <span className="reviews-dist-label">{star}&#9733;</span>
                              <div className="reviews-dist-bar"><div className="reviews-dist-fill" style={{ width: pct + '%' }} /></div>
                              <span className="reviews-dist-pct">{pct}%</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p style={{ color: 'var(--stone-400)', fontSize: '0.875rem', fontStyle: 'italic' }}>No reviews yet. Be the first to share your experience.</p>
                  )}
                </div>
                {/* Right — form + review cards */}
                <div className="reviews-main" ref={reviewsMainRef}>
                  {customer ? (
                    reviewSubmitted ? (
                      <div className="review-submitted">
                        <div className="review-submitted-label">&#10003; Submitted for review</div>
                        <div className="review-submitted-msg">Thanks &mdash; we&rsquo;ll publish it within 24 hours.</div>
                      </div>
                    ) : (
                      <div className="review-form">
                        <div>
                          <div className="review-form-title">Write a review</div>
                          <div className="review-form-sub">Posting as <strong>{tradeCustomer ? 'Roma Trade Member' : 'Verified Buyer'}</strong></div>
                        </div>
                        <div>
                          <div className="review-form-label">Rating</div>
                          <div className="star-picker">
                            {[1,2,3,4,5].map(i => (
                              <button key={i}
                                className={(i <= (reviewHover || reviewRating) ? 'active' : '') + (i <= reviewHover ? ' hover' : '')}
                                onMouseEnter={() => setReviewHover(i)}
                                onMouseLeave={() => setReviewHover(0)}
                                onClick={() => setReviewRating(i)}
                              >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill={i <= (reviewHover || reviewRating) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
                                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01z"/>
                                </svg>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="review-form-label">Title</div>
                          <input type="text" placeholder="One-line summary" value={reviewTitle} onChange={e => setReviewTitle(e.target.value)} maxLength={200} />
                        </div>
                        <div>
                          <div className="review-form-label">Your review</div>
                          <textarea placeholder="What worked, what didn't, what you'd tell the next buyer." value={reviewBody} onChange={e => setReviewBody(e.target.value)} />
                        </div>
                        <div className="review-form-actions">
                          <button className="pdp-btn pdp-btn-primary" onClick={handleReviewSubmit} disabled={reviewSubmitting || reviewRating < 1}>
                            {reviewSubmitting ? 'Submitting...' : 'Submit Review'}
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="review-signin">
                      <div>
                        <div className="review-signin-text">Sign in to write a review.</div>
                        <div className="review-signin-sub">Verified buyers only &mdash; no anonymous comments, no incentives.</div>
                      </div>
                      <button className="pdp-btn pdp-btn-primary" onClick={e => { e.preventDefault(); onShowAuth(); }}>Sign in</button>
                    </div>
                  )}
                  {reviews.map(r => (
                    <div key={r.id} className="review-card">
                      <div className="review-card-header">
                        <div>
                          <div className="review-card-author">{r.first_name}</div>
                          <div className="review-card-meta">
                            {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            {' \u00B7 '}<span className="verified">&#10003; Verified</span>
                          </div>
                        </div>
                        <StarDisplay rating={r.rating} size={14} />
                      </div>
                      {r.title && <div className="review-card-title">{r.title}</div>}
                      {r.body && <div className="review-card-body">{r.body}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      );
    }

    // ==================== Cart Page ====================

    function CartPage({ cart, goBrowse, removeFromCart, updateCartItem, goCheckout, deliveryMethod, setDeliveryMethod, liftgateEnabled, setLiftgateEnabled, sessionId, appliedPromoCode, setAppliedPromoCode, goHome }) {
      const [shippingZip, setShippingZip] = useState('');
      const [shippingEstimate, setShippingEstimate] = useState(null);
      const [shippingLoading, setShippingLoading] = useState(false);
      const [shippingError, setShippingError] = useState('');
      const [selectedShippingOption, setSelectedShippingOption] = useState(null);
      const [promoCode, setPromoCode] = useState(appliedPromoCode || '');
      const [promoResult, setPromoResult] = useState(null);
      const [promoLoading, setPromoLoading] = useState(false);
      const [promoError, setPromoError] = useState('');
      const promoSubtotalRef = useRef(null);

      const productItems = cart.filter(i => !i.is_sample);
      const sampleItems = cart.filter(i => i.is_sample);
      const hasOutOfStock = productItems.some(i => i.stock_status === 'out_of_stock' && i.vendor_has_inventory);
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
          const sqftPerBox = item.sqft_needed && parseInt(item.num_boxes) > 0 ? parseFloat(item.sqft_needed) / parseInt(item.num_boxes) : 17.11;
          const newSqft = (newBoxes * sqftPerBox).toFixed(2);
          const newSubtotal = (newBoxes * sqftPerBox * unitPrice).toFixed(2);
          updateCartItem(item.id, { num_boxes: newBoxes, sqft_needed: newSqft, subtotal: newSubtotal });
        }
        setShippingEstimate(null);
        setSelectedShippingOption(null);
      };

      const totalSqft = boxItems.reduce((sum, i) => sum + parseFloat(i.sqft_needed || 0), 0);

      // --- Empty cart state ---
      if (cart.length === 0) {
        return (
          <div className="ct-wrap">
            <section className="ct-header">
              <nav className="ct-breadcrumb">
                <a onClick={goHome}>Home</a>
                <span className="ct-breadcrumb-sep" />
                <a onClick={goBrowse}>Shop</a>
                <span className="ct-breadcrumb-sep" />
                <span className="ct-breadcrumb-current">Your Cart</span>
              </nav>
              <div className="ct-hero-grid">
                <div>
                  <div className="ct-eyebrow" style={{ color: 'var(--gold)' }}>0 items · cart empty</div>
                  <h1 className="ct-title">Nothing in the cart, <em>yet</em>.</h1>
                </div>
                <div className="ct-hero-right">
                  <p className="ct-hero-desc">Start a sample box, pick up where you left off, or browse the showroom by material. Anything you add will sit here, saved across devices, until you're ready to check out.</p>
                  <div className="ct-hero-actions">
                    <button className="ct-btn-primary" onClick={goBrowse}>Browse the shop</button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        );
      }

      // --- Cart item count label ---
      const itemCount = productItems.length + sampleItems.length;
      const materialLabel = productItems.length === 1 ? '1 material' : productItems.length + ' materials';
      const sampleLabel = sampleItems.length > 0 ? (sampleItems.length === 1 ? ' · 1 sample' : ' · ' + sampleItems.length + ' samples') : '';

      return (
        <div className="ct-wrap">
          {/* --- Cart header --- */}
          <section className="ct-header">
            <div className="ct-header-top">
              <nav className="ct-breadcrumb">
                <a onClick={goHome}>Home</a>
                <span className="ct-breadcrumb-sep" />
                <a onClick={goBrowse}>Shop</a>
                <span className="ct-breadcrumb-sep" />
                <span className="ct-breadcrumb-current">Your Cart</span>
              </nav>
            </div>
            <div className="ct-hero-grid">
              <div>
                <div className="ct-eyebrow" style={{ color: 'var(--gold)' }}>{materialLabel}{sampleLabel} · in your cart</div>
                <h1 className="ct-title">Your <em>cart</em>.</h1>
              </div>
              <div className="ct-hero-right">
                {totalSqft > 0 && (
                  <div className="ct-stats-strip">
                    <div className="ct-stat">
                      <div className="ct-stat-value">{Math.round(totalSqft)} sf</div>
                      <div className="ct-stat-label">Materials</div>
                    </div>
                    <div className="ct-stat">
                      <div className="ct-stat-value">${productSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      <div className="ct-stat-label">Subtotal</div>
                    </div>
                    <div className="ct-stat">
                      <div className="ct-stat-value">{itemCount}</div>
                      <div className="ct-stat-label">{itemCount === 1 ? 'Item' : 'Items'}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* --- Main grid: items + summary --- */}
          <div className="ct-grid">
            {/* LEFT: Line items */}
            <div className="ct-items">
              <div className="ct-items-header">
                <h2 className="ct-items-title">Materials</h2>
              </div>

              {cart.map((item, idx) => {
                const isLast = idx === cart.length - 1;
                const sqft = parseFloat(item.sqft_needed || 0);
                const boxes = parseInt(item.num_boxes) || 0;
                const unitPrice = parseFloat(item.unit_price) || 0;
                const subtotal = parseFloat(item.subtotal || 0);
                const canStepper = !item.is_sample && item.sell_by !== 'sqft' && !item.price_tier;
                const priceSuf = item.sell_by === 'unit' ? '/ea' : item.sell_by === 'roll' ? '/sqyd' : '/sqft';

                return (
                  <div key={item.id} className={'ct-line' + (isLast ? ' ct-line-last' : '')}>
                    {/* Thumbnail */}
                    <div className="ct-line-thumb">
                      {item.primary_image ? (
                        <img src={optimizeImg(item.primary_image, 200)} alt="" onLoad={handleProductImgLoad} loading="lazy" decoding="async" />
                      ) : (
                        <div className="ct-line-thumb-placeholder" />
                      )}
                      {item.is_sample && <span className="ct-line-sample-badge">Sample</span>}
                    </div>

                    {/* Middle: title + meta */}
                    <div className="ct-line-info">
                      <div className="ct-line-cat">{item.category_name || ''}</div>
                      <h3 className="ct-line-name">{fullProductName(item) || 'Product'}</h3>
                      {item.variant_name && <div className="ct-line-variant">{item.variant_name}</div>}

                      {/* Lead-time / stock */}
                      {item.stock_status && item.stock_status !== 'unknown' && (
                        <div className={'ct-line-stock' + (item.stock_status === 'in_stock' ? ' in-stock' : item.stock_status === 'low_stock' ? ' low-stock' : ' out-stock')}>
                          {item.stock_status === 'in_stock' ? 'In stock' : item.stock_status === 'low_stock' ? 'Low stock' : 'Out of stock'}
                        </div>
                      )}
                      {item.stock_status === 'out_of_stock' && item.vendor_has_inventory && !item.is_sample && (
                        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '0.375rem', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', color: '#991b1b', marginTop: '0.375rem' }}>
                          This item is out of stock — remove it to proceed
                        </div>
                      )}

                      {/* Pickup-only badge */}
                      {item.pickup_only && (
                        <div className="ct-line-pickup-badge">Pickup only</div>
                      )}

                      {/* Actions */}
                      <div className="ct-line-actions">
                        <a className="ct-line-action-remove" onClick={() => removeFromCart(item.id)}>Remove</a>
                      </div>
                    </div>

                    {/* Right: qty + subtotal */}
                    <div className="ct-line-right">
                      {/* Qty stepper */}
                      {canStepper && (
                        <div className="ct-qty-wrap">
                          <div className="ct-qty-stepper">
                            <button className="ct-qty-btn" onClick={() => handleQtyChange(item, -1)} aria-label="Decrease quantity">&minus;</button>
                            <span className="ct-qty-value">{boxes} {item.sell_by === 'unit' ? (boxes === 1 ? 'unit' : 'units') : (boxes === 1 ? 'box' : 'boxes')}</span>
                            <button className="ct-qty-btn" onClick={() => handleQtyChange(item, 1)} aria-label="Increase quantity">+</button>
                          </div>
                          {item.sell_by !== 'unit' && sqft > 0 && (
                            <div className="ct-qty-coverage">{sqft.toFixed(1)} sf coverage</div>
                          )}
                        </div>
                      )}
                      {!canStepper && !item.is_sample && (
                        <div className="ct-qty-wrap">
                          <div className="ct-qty-static">{item.sell_by === 'sqft' || item.price_tier ? `${sqft.toFixed(0)} sqft` : `${boxes} ${item.sell_by === 'unit' ? 'unit' : 'box'}${boxes !== 1 ? (item.sell_by === 'unit' ? 's' : 'es') : ''}`}</div>
                        </div>
                      )}

                      {/* Unit price */}
                      {!item.is_sample && (
                        <div className="ct-line-unit-price">
                          <span>Unit price</span>
                          <span className="ct-line-unit-price-value">${unitPrice.toFixed(2)}<span className="ct-line-unit-price-suffix">{priceSuf}</span></span>
                        </div>
                      )}

                      {item.price_tier && (
                        <div className="ct-line-price-tier">{item.price_tier === 'roll' ? 'Roll price' : 'Cut price'}</div>
                      )}

                      {/* Subtotal */}
                      <div className="ct-line-subtotal">
                        <span className="ct-line-subtotal-label">Subtotal</span>
                        <span className="ct-line-subtotal-value">{item.is_sample ? 'Free' : '$' + subtotal.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Promo + keep browsing */}
              <div className="ct-promo-row">
                <div className="ct-promo-input-wrap">
                  {promoResult ? (
                    <div className="ct-promo-applied">
                      <span className="ct-promo-code-pill">{promoResult.code}</span>
                      <span className="ct-promo-discount">-${promoDiscount.toFixed(2)}</span>
                      <a className="ct-promo-remove" onClick={e => { e.preventDefault(); removePromo(); }}>Remove</a>
                    </div>
                  ) : (
                    <div className="ct-promo-form">
                      <input type="text" value={promoCode} onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoError(''); }}
                        placeholder="Promo code or trade ID" onKeyDown={e => e.key === 'Enter' && applyPromoCode()}
                        className="ct-promo-input" />
                      <button onClick={() => applyPromoCode()} disabled={promoLoading || !promoCode.trim()} className="ct-promo-apply">
                        {promoLoading ? '...' : 'Apply'}
                      </button>
                    </div>
                  )}
                  {promoError && <div className="ct-promo-error">{promoError}</div>}
                  {promoResult && promoResult.description && <div className="ct-promo-desc">{promoResult.description}</div>}
                </div>
                <a className="ct-keep-browsing" onClick={e => { e.preventDefault(); goBrowse(); }}>&#8592; Keep browsing</a>
              </div>
            </div>

            {/* RIGHT: Order summary */}
            <aside className="ct-summary">
              <div className="ct-summary-inner">
                <div className="ct-summary-eyebrow">Order summary</div>

                {/* Summary line items */}
                <div className="ct-summary-lines">
                  {productItems.length > 0 && (
                    <div className="ct-summary-line">
                      <span>Materials subtotal</span>
                      <span>${productSubtotal.toFixed(2)}</span>
                    </div>
                  )}
                  {sampleItems.length > 0 && (
                    <>
                      <div className="ct-summary-line"><span>Samples ({sampleItems.length})</span><span>Free</span></div>
                      <div className="ct-summary-line"><span>Sample shipping</span><span>$12.00</span></div>
                    </>
                  )}
                  {promoResult && (
                    <div className="ct-summary-line ct-summary-line-accent">
                      <span>Promo · {promoResult.code}</span>
                      <span>-${promoDiscount.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                {/* Delivery method */}
                {productItems.length > 0 && (
                  <div className="ct-summary-delivery">
                    <div className="ct-summary-delivery-label">Delivery</div>
                    {hasPickupOnly && (
                      <div className="ct-summary-pickup-notice">Cart contains pickup-only items.</div>
                    )}
                    <label className={'ct-delivery-option' + (deliveryMethod === 'pickup' ? ' active' : '')}>
                      <input type="radio" name="ctDelivery" value="pickup" checked={deliveryMethod === 'pickup'}
                        onChange={() => { setDeliveryMethod('pickup'); setShippingEstimate(null); setSelectedShippingOption(null); }} />
                      <div>
                        <div className="ct-delivery-option-title">Showroom pickup</div>
                        <div className="ct-delivery-option-sub">Free · Anaheim</div>
                      </div>
                    </label>
                    <label className={'ct-delivery-option' + (deliveryMethod === 'shipping' ? ' active' : '') + (hasPickupOnly ? ' disabled' : '')}>
                      <input type="radio" name="ctDelivery" value="shipping" checked={deliveryMethod === 'shipping'}
                        onChange={() => setDeliveryMethod('shipping')} disabled={hasPickupOnly} />
                      <div>
                        <div className="ct-delivery-option-title">Ship to address</div>
                        <div className="ct-delivery-option-sub">Enter ZIP for rate</div>
                      </div>
                    </label>

                    {deliveryMethod === 'shipping' && (
                      <div className="ct-summary-shipping">
                        <div className="ct-shipping-zip-row">
                          <input type="text" placeholder="ZIP Code" value={shippingZip}
                            onChange={e => setShippingZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                            onKeyDown={e => e.key === 'Enter' && fetchShippingEstimate()}
                            maxLength={5} className="ct-shipping-zip-input" />
                          <button onClick={fetchShippingEstimate} disabled={shippingLoading || shippingZip.length < 5} className="ct-shipping-zip-btn">
                            {shippingLoading ? '...' : 'Get rate'}
                          </button>
                        </div>
                        {shippingError && <div className="ct-shipping-error">{shippingError}</div>}
                        {shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount > 0 && (
                          <div className="ct-shipping-options">
                            {shippingEstimate.options.map(opt => (
                              <label key={opt.id} className={'ct-shipping-opt' + (selectedShippingOption && selectedShippingOption.id === opt.id ? ' active' : '')}
                                onClick={() => setSelectedShippingOption(opt)}>
                                <input type="radio" name="ctShipping" checked={selectedShippingOption && selectedShippingOption.id === opt.id}
                                  onChange={() => setSelectedShippingOption(opt)} />
                                <div className="ct-shipping-opt-info">
                                  <span className="ct-shipping-opt-carrier">{opt.carrier}</span>
                                  {opt.transit_days && <span className="ct-shipping-opt-days">{opt.transit_days} day{opt.transit_days !== 1 ? 's' : ''}</span>}
                                </div>
                                <span className="ct-shipping-opt-price">${parseFloat(opt.amount).toFixed(2)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount === 0 && shippingEstimate.method === null && (
                          <div className="ct-summary-line" style={{ marginTop: 8 }}><span>Shipping</span><span>$0.00</span></div>
                        )}
                        {shippingEstimate && shippingEstimate.weight_lbs > 0 && (
                          <div className="ct-shipping-weight">Est. weight: {shippingEstimate.weight_lbs} lbs{shippingEstimate.weight_estimated ? ' *' : ''}</div>
                        )}
                        {shippingEstimate && shippingEstimate.weight_estimated && (
                          <div className="ct-shipping-weight" style={{ fontSize: '0.75rem', color: 'var(--stone-500)', marginTop: 2 }}>* Some item weights estimated. Final shipping may vary.</div>
                        )}
                        {shippingEstimate && shippingEstimate.method === 'ltl_freight' && (
                          <label className="ct-liftgate-toggle">
                            <input type="checkbox" checked={liftgateEnabled} onChange={e => {
                              setLiftgateEnabled(e.target.checked);
                              setShippingEstimate(null);
                              setSelectedShippingOption(null);
                            }} />
                            Liftgate delivery (residential)
                          </label>
                        )}
                      </div>
                    )}

                    {deliveryMethod === 'pickup' && (
                      <div className="ct-summary-line" style={{ marginTop: 8 }}>
                        <span>Shipping</span>
                        <span style={{ color: 'var(--gold)' }}>Free</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Total */}
                <div className="ct-summary-total">
                  <span className="ct-summary-total-label">{selectedShippingOption ? 'Estimated total' : 'Subtotal'}</span>
                  <span className="ct-summary-total-value">${cartTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>

                {/* CTA */}
                <button className="ct-checkout-btn" onClick={goCheckout} disabled={hasOutOfStock}>
                  {hasOutOfStock ? 'Remove out-of-stock items to checkout' : 'Checkout securely'}
                </button>

                {/* Trust */}
                <div className="ct-summary-trust">
                  <div>Secure checkout · Stripe</div>
                  <div>(714) 999-0009</div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      );
    }

    // ==================== Checkout Page ====================

    function CheckoutPage({ cart, sessionId, goCart, handleOrderComplete, deliveryMethod, setDeliveryMethod, liftgateEnabled, tradeCustomer, tradeToken, customer, customerToken, onCustomerLogin, klarnaError, clearKlarnaError, appliedPromoCode, setAppliedPromoCode }) {
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
      const [saveCard, setSaveCard] = useState(true);
      const [savedCards, setSavedCards] = useState([]);
      const [selectedSavedPm, setSelectedSavedPm] = useState(null); // null = pay with a new card
      const prefilledRef = useRef(false);
      const [taxEstimate, setTaxEstimate] = useState({ rate: 0, amount: 0 });
      const [promoInfo, setPromoInfo] = useState(null);
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
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const [walletMode, setWalletMode] = useState(null);
      const [orderNotes, setOrderNotes] = useState('');
      const [editingContact, setEditingContact] = useState(!customer && !tradeCustomer);
      const [editingAddress, setEditingAddress] = useState(!customer || !customer.address_line1);
      const [measureRequested, setMeasureRequested] = useState(false);
      const [preferredDate, setPreferredDate] = useState('');
      const [preferredTime, setPreferredTime] = useState('');

      const cartEmpty = !cart || cart.length === 0;

      const isPickup = deliveryMethod === 'pickup';
      const productItems = cart.filter(i => !i.is_sample);
      const sampleItems = cart.filter(i => i.is_sample);
      const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
      const sampleShipping = sampleItems.length > 0 ? 12 : 0;
      // Promo discount reduces the merchandise subtotal AND the taxable base
      // (CA taxes post-discount), mirroring the server's charge calculation.
      const promoDiscount = promoInfo ? parseFloat(promoInfo.discount_amount || 0) : 0;
      const taxableBase = Math.max(0, productSubtotal - promoDiscount);
      const estTax = Math.round(taxEstimate.rate * taxableBase * 100) / 100;
      const cartTotal = taxableBase + sampleShipping + estTax;

      const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

      useEffect(() => {
        if (cartEmpty || cardMounted.current) return;
        let cancelled = false;
        // Wait for Stripe.js — it loads async and can finish after this mounts
        ensureStripe().then(stripe => {
          if (cancelled || !stripe || cardMounted.current) return;
          const el = document.getElementById('card-element');
          if (!el) return;
          const elements = stripe.elements();
          const card = elements.create('card', {
            style: { base: { fontFamily: "'Inter', sans-serif", fontSize: '15px', color: '#292524', '::placeholder': { color: '#57534e' } } }
          });
          card.mount(el);
          cardRef.current = card;
          cardMounted.current = true;
        });
        return () => { cancelled = true; if (cardRef.current) { cardRef.current.unmount(); cardRef.current = null; cardMounted.current = false; } };
      }, [cartEmpty]);

      // Apple Pay / Google Pay via Payment Request API
      useEffect(() => {
        let cancelled = false;
        ensureStripe().then(stripe => {
          if (cancelled || !stripe) return;
          const pr = stripe.paymentRequest({
            country: 'US',
            currency: 'usd',
            total: { label: 'Roma Flooring Designs', amount: Math.round(cartTotal * 100) || 100 },
            requestPayerName: true,
            requestPayerEmail: true,
            requestPayerPhone: true,
          });
          pr.canMakePayment().then(result => {
            if (cancelled) return;
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
        });
        return () => { cancelled = true; };
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
            const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || undefined };
            if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = liftgateEnabled; }
            const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(piBody)
            });
            const piData = await piRes.json();
            if (piData.error) {
              ev.complete('fail'); setError(piData.error);
              if (piData.out_of_stock_sku_ids) { setTimeout(() => { if (typeof goCart === 'function') goCart(); }, 3000); }
              return;
            }

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
              residential: true, liftgate: liftgateEnabled, promo_code: appliedPromoCode || undefined,
              notes: orderNotes || undefined,
              measure_requested: measureRequested || undefined,
              preferred_measure_date: measureRequested && preferredDate ? preferredDate : undefined,
              preferred_measure_time: measureRequested && preferredTime ? preferredTime : undefined
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
          const usingSavedCard = !!(customerToken && selectedSavedPm);
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || undefined };
          if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = liftgateEnabled; }
          if (usingSavedCard) piBody.saved_payment_method_id = selectedSavedPm;
          else if (customerToken && saveCard) piBody.save_card = true;
          const piHeaders = { 'Content-Type': 'application/json' };
          if (customerToken) piHeaders['X-Customer-Token'] = customerToken;
          const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
            method: 'POST', headers: piHeaders, body: JSON.stringify(piBody)
          });
          const piData = await piRes.json();
          if (piData.error) {
            setError(piData.error); setProcessing(false);
            if (piData.out_of_stock_sku_ids) { setTimeout(() => { if (typeof goCart === 'function') goCart(); }, 3000); }
            return;
          }

          let confirmedPiId;
          if (usingSavedCard) {
            if (piData.status === 'succeeded') {
              confirmedPiId = piData.paymentIntentId;
            } else if (piData.requires_action || piData.status === 'requires_action') {
              const { error: actionError, paymentIntent: actionPi } = await stripeInstance.confirmCardPayment(piData.clientSecret);
              if (actionError) { setError(actionError.message); setProcessing(false); return; }
              confirmedPiId = actionPi.id;
            } else {
              setError('Your saved card could not be charged. Please try another card.'); setProcessing(false); return;
            }
          } else {
            const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
              piData.clientSecret, { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
            );
            if (stripeError) { setError(stripeError.message); setProcessing(false); return; }
            confirmedPiId = paymentIntent.id;
          }

          const orderBody = {
            session_id: sessionId, payment_intent_id: confirmedPiId,
            customer_name: customerName, customer_email: customerEmail, phone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true, liftgate: liftgateEnabled, promo_code: appliedPromoCode || undefined,
            create_account: createAccount || undefined,
            account_password: createAccount ? accountPassword : undefined,
            notes: orderNotes || undefined,
            measure_requested: measureRequested || undefined,
            preferred_measure_date: measureRequested && preferredDate ? preferredDate : undefined,
            preferred_measure_time: measureRequested && preferredTime ? preferredTime : undefined
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
          handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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

      // Prefill contact + address once the signed-in customer loads (the
      // profile arrives async, after this component first mounts). Only fills
      // fields the shopper hasn't already typed into.
      useEffect(() => {
        if (prefilledRef.current || !customer) return;
        prefilledRef.current = true;
        const full = ((customer.first_name || '') + ' ' + (customer.last_name || '')).trim();
        setCustomerName(prev => prev || full);
        setCustomerEmail(prev => prev || customer.email || '');
        setPhone(prev => prev || customer.phone || '');
        setLine1(prev => prev || customer.address_line1 || '');
        setLine2(prev => prev || customer.address_line2 || '');
        setCity(prev => prev || customer.city || '');
        setState(prev => prev || customer.state || '');
        setZip(prev => prev || customer.zip || '');
        if (full && customer.email) setEditingContact(false);
        if (customer.address_line1) setEditingAddress(false);
      }, [customer]);

      // Load the customer's saved cards on file
      useEffect(() => {
        if (!customerToken) { setSavedCards([]); return; }
        fetch(API + '/api/customer/payment-methods', { headers: { 'X-Customer-Token': customerToken } })
          .then(r => r.ok ? r.json() : { cards: [] })
          .then(d => {
            const cards = d.cards || [];
            setSavedCards(cards);
            if (cards.length) setSelectedSavedPm(cards[0].id);
          })
          .catch(() => setSavedCards([]));
      }, [customerToken]);

      // Surface a Klarna-return error (set at the app level after redirect)
      useEffect(() => {
        if (klarnaError) { setError(klarnaError); if (clearKlarnaError) clearKlarnaError(); }
      }, []);

      // Fetch tax estimate when ZIP changes
      useEffect(() => {
        const taxZip = isPickup ? '92806' : zip;
        if (!taxZip || taxZip.length < 5) { setTaxEstimate({ rate: 0, amount: 0 }); return; }
        clearTimeout(taxDebounce.current);
        taxDebounce.current = setTimeout(async () => {
          try {
            const resp = await fetch(API + '/api/cart/tax-estimate?zip=' + encodeURIComponent(taxZip) + '&session_id=' + encodeURIComponent(sessionId));
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            setTaxEstimate({ rate: data.rate || 0, amount: data.amount || 0 });
          } catch(e) { setTaxEstimate({ rate: 0, amount: 0 }); }
        }, 400);
        return () => clearTimeout(taxDebounce.current);
      }, [zip, isPickup, sessionId]);

      // Resolve the applied promo (entered on the cart page) so we can show the
      // discount and tax the post-discount base — matching what's charged.
      useEffect(() => {
        if (!appliedPromoCode || !sessionId) { setPromoInfo(null); return; }
        let cancelled = false;
        fetch(API + '/api/promo-codes/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: appliedPromoCode, session_id: sessionId, customer_email: customerEmail || undefined })
        })
          .then(r => r.ok ? r.json() : { valid: false })
          .then(d => { if (!cancelled) setPromoInfo(d && d.valid ? d : null); })
          .catch(() => { if (!cancelled) setPromoInfo(null); });
        return () => { cancelled = true; };
      }, [appliedPromoCode, sessionId, productSubtotal]);

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
          const usingSavedCard = !!(customerToken && selectedSavedPm);
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || undefined };
          if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = liftgateEnabled; }
          if (usingSavedCard) piBody.saved_payment_method_id = selectedSavedPm;
          else if (customerToken && saveCard) piBody.save_card = true;
          const piHeaders = { 'Content-Type': 'application/json' };
          if (customerToken) piHeaders['X-Customer-Token'] = customerToken;
          const piRes = await fetch(API + '/api/checkout/create-payment-intent', {
            method: 'POST', headers: piHeaders, body: JSON.stringify(piBody)
          });
          const piData = await piRes.json();
          if (piData.error) {
            setError(piData.error); setProcessing(false);
            if (piData.out_of_stock_sku_ids) { setTimeout(() => { if (typeof goCart === 'function') goCart(); }, 3000); }
            return;
          }

          let confirmedPiId;
          if (usingSavedCard) {
            if (piData.status === 'succeeded') {
              confirmedPiId = piData.paymentIntentId;
            } else if (piData.requires_action || piData.status === 'requires_action') {
              const { error: actionError, paymentIntent: actionPi } = await stripeInstance.confirmCardPayment(piData.clientSecret);
              if (actionError) { setError(actionError.message); setProcessing(false); return; }
              confirmedPiId = actionPi.id;
            } else {
              setError('Your saved card could not be charged. Please try another card.'); setProcessing(false); return;
            }
          } else {
            const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
              piData.clientSecret, { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
            );
            if (stripeError) { setError(stripeError.message); setProcessing(false); return; }
            confirmedPiId = paymentIntent.id;
          }

          const orderBody = {
            session_id: sessionId, payment_intent_id: confirmedPiId,
            customer_name: customerName, customer_email: customerEmail, phone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true, liftgate: liftgateEnabled, promo_code: appliedPromoCode || undefined,
            create_account: createAccount || undefined,
            account_password: createAccount ? accountPassword : undefined,
            notes: orderNotes || undefined,
            measure_requested: measureRequested || undefined,
            preferred_measure_date: measureRequested && preferredDate ? preferredDate : undefined,
            preferred_measure_time: measureRequested && preferredTime ? preferredTime : undefined
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
          handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
        } catch (err) {
          setError(err.message || 'Something went wrong. Please try again.');
          setProcessing(false);
        }
      };

      // Pay with Klarna — redirects to Klarna's hosted flow, then returns to
      // /checkout where the app finalizes the order (see finalizeKlarnaOrder)
      const handleKlarnaPay = async () => {
        setError('');
        const nameParts = customerName.trim().split(/\s+/);
        if (nameParts.length < 2 || nameParts[0].length < 2 || nameParts[1].length < 1) { setError('Please enter your full name (first and last).'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail)) { setError('Please enter a valid email address.'); return; }
        if (phone.replace(/\D/g, '').length < 10) { setError('Please enter a valid 10-digit phone number.'); return; }
        if (!isPickup) {
          if (!line1.trim()) { setError('Please enter a street address.'); return; }
          if (!city.trim()) { setError('Please enter a city.'); return; }
          if (!state) { setError('Please select a state.'); return; }
          if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) { setError('Please enter a valid ZIP code.'); return; }
        }
        setProcessing(true);
        try {
          const stripe = await ensureStripe();
          if (!stripe) { setError('Payment system is still loading — please try again in a moment.'); setProcessing(false); return; }
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || undefined };
          if (!isPickup) { piBody.destination = { zip, city, state }; piBody.residential = true; piBody.liftgate = liftgateEnabled; }
          const piHeaders = { 'Content-Type': 'application/json' };
          if (customerToken) piHeaders['X-Customer-Token'] = customerToken;
          const piRes = await fetch(API + '/api/checkout/create-payment-intent', { method: 'POST', headers: piHeaders, body: JSON.stringify(piBody) });
          const piData = await piRes.json();
          if (piData.error) {
            setError(piData.error); setProcessing(false);
            if (piData.out_of_stock_sku_ids) { setTimeout(() => { if (typeof goCart === 'function') goCart(); }, 3000); }
            return;
          }
          // Stash the order details — React state is lost across the redirect
          const orderBody = {
            session_id: sessionId, customer_name: customerName, customer_email: customerEmail, phone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true, liftgate: liftgateEnabled, promo_code: appliedPromoCode || undefined,
            create_account: createAccount || undefined,
            account_password: createAccount ? accountPassword : undefined,
            notes: orderNotes || undefined,
            measure_requested: measureRequested || undefined,
            preferred_measure_date: measureRequested && preferredDate ? preferredDate : undefined,
            preferred_measure_time: measureRequested && preferredTime ? preferredTime : undefined,
          };
          sessionStorage.setItem('klarna_pending', JSON.stringify({ orderBody, ts: Date.now() }));
          const billingAddress = isPickup
            ? { country: 'US', postal_code: '92806' }
            : { country: 'US', line1, line2: line2 || undefined, city, state, postal_code: zip };
          const { error: kErr } = await stripe.confirmKlarnaPayment(piData.clientSecret, {
            payment_method: { billing_details: { name: customerName, email: customerEmail, phone, address: billingAddress } },
            return_url: window.location.origin + '/checkout',
          });
          // Reaches here only if the redirect didn't happen (validation error)
          if (kErr) { setError(kErr.message); sessionStorage.removeItem('klarna_pending'); setProcessing(false); }
        } catch (err) {
          setError('Klarna could not be started. Please try again or pay by card.');
          sessionStorage.removeItem('klarna_pending');
          setProcessing(false);
        }
      };

      const contactSaved = customerName.trim().length > 2 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail) && phone.replace(/\D/g, '').length >= 10;
      const addressSaved = isPickup || (line1.trim() && city.trim() && state && /^\d{5}(-\d{4})?$/.test(zip.trim()));
      const initials = customerName.trim().split(/\s+/).map(n => n[0] || '').join('').toUpperCase().slice(0, 2);

      const formatPhone = (val) => {
        const digits = val.replace(/\D/g, '').slice(0, 10);
        let fmt = ''; if (digits.length > 0) fmt = '(' + digits.slice(0, 3);
        if (digits.length >= 3) fmt += ') '; if (digits.length > 3) fmt += digits.slice(3, 6);
        if (digits.length >= 6) fmt += '-' + digits.slice(6);
        return fmt;
      };

      if (cartEmpty) {
        return (
          <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
            <h2>Your cart is empty</h2>
            <p style={{ color: 'var(--stone-500)', margin: '1rem 0' }}>Add items to your cart before checking out.</p>
            <button className="btn" onClick={goCart}>Go to Cart</button>
          </div>
        );
      }

      return (
        <div className="co-wrap">
          {/* Slim checkout header */}
          <div className="co-header">
            <a className="co-header-logo" onClick={(e) => { e.preventDefault(); goCart(); }} href="#">Roma</a>
            <div className="co-header-meta">
              <span className="co-phone">(714) 999-0009</span>
              <span className="co-secure">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                Secure checkout
              </span>
            </div>
          </div>

          {/* Progress strip */}
          <div className="co-progress">
            <div className="co-progress-inner">
              <div className="co-progress-step">
                <div className="co-progress-dot past">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div>
                  <div className="co-progress-label">Cart</div>
                  <div className="co-progress-status">Complete</div>
                </div>
              </div>
              <div className="co-progress-step">
                <div className="co-progress-dot current">2</div>
                <div>
                  <div className="co-progress-label">Checkout</div>
                  <div className="co-progress-status">In progress</div>
                </div>
              </div>
              <div className="co-progress-step">
                <div className="co-progress-dot future">3</div>
                <div>
                  <div className="co-progress-label">Confirmation</div>
                  <div className="co-progress-status">&mdash;</div>
                </div>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="co-grid">
              {/* LEFT: Step sections */}
              <div className="co-steps">
                {error && <div className="co-error">{error}</div>}

                {/* Step 01 — Contact */}
                <div className={`co-step ${editingContact ? 'focus' : ''}`}>
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className={`co-step-num ${contactSaved && !editingContact ? 'saved' : ''}`}>01</span>
                      <h3 className="co-step-title">Contact</h3>
                    </div>
                    {contactSaved && !editingContact && (
                      <div className="co-step-chip">
                        <span className="co-step-chip-label" style={{ color: 'var(--gold)' }}>Saved</span>
                        <button type="button" className="co-step-chip-action" onClick={() => setEditingContact(true)}>Edit</button>
                      </div>
                    )}
                  </div>
                  {editingContact ? (
                    <div className="co-form-grid">
                      <div className="co-form-row-2">
                        <div className="co-field">
                          <div className="co-field-label">Full name</div>
                          <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="John Smith" />
                        </div>
                        <div className="co-field">
                          <div className="co-field-label">Email</div>
                          <input type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="john@example.com" />
                        </div>
                      </div>
                      <div className="co-field">
                        <div className="co-field-label">Phone</div>
                        <input type="tel" value={phone} onChange={e => setPhone(formatPhone(e.target.value))} placeholder="(555) 123-4567" />
                      </div>
                      {!customer && !tradeCustomer && (
                        <>
                          <label className="co-create-account">
                            <input type="checkbox" checked={createAccount} onChange={e => { setCreateAccount(e.target.checked); if (!e.target.checked) { setAccountPassword(''); setConfirmPassword(''); setPasswordError(''); } }} />
                            Create an account for faster checkout
                          </label>
                          {createAccount && (
                            <div className="co-password-fields">
                              <div className="co-field">
                                <div className="co-field-label">Password</div>
                                <input type="password" value={accountPassword} onChange={e => { setAccountPassword(e.target.value); setPasswordError(''); }} placeholder="Min 8 chars, 1 uppercase, 1 number" autoComplete="new-password" />
                              </div>
                              <div className="co-field">
                                <div className="co-field-label">Confirm password</div>
                                <input type="password" value={confirmPassword} onChange={e => { setConfirmPassword(e.target.value); setPasswordError(''); }} placeholder="Re-enter password" autoComplete="new-password" />
                              </div>
                              {passwordError && <div className="co-password-error">{passwordError}</div>}
                            </div>
                          )}
                        </>
                      )}
                      {contactSaved && (
                        <button type="button" style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--stone-800)', color: 'var(--warm-bg)', border: 'none', font: '500 0.75rem/1 var(--font-body)', letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer' }} onClick={() => setEditingContact(false)}>Save contact</button>
                      )}
                    </div>
                  ) : (
                    <div className="co-contact-saved">
                      <div className="co-contact-avatar">{initials || '?'}</div>
                      <div>
                        <div className="co-contact-info">{customerName} &middot; {customerEmail}</div>
                        {phone && <div className="co-contact-meta">{phone}</div>}
                        {tradeCustomer && <div className="co-contact-meta">Trade account &middot; {tradeCustomer.company_name}</div>}
                      </div>
                    </div>
                  )}
                </div>

                {/* Step 02 — Delivery method */}
                <div className="co-step focus">
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className="co-step-num">02</span>
                      <h3 className="co-step-title">Delivery</h3>
                    </div>
                  </div>
                  <div className="co-delivery-grid">
                    <button type="button" className={`co-delivery-card ${isPickup ? 'selected' : ''}`} onClick={() => { if (typeof setDeliveryMethod === 'function') setDeliveryMethod('pickup'); }}>
                      <div className="co-delivery-card-top">
                        <div>
                          <div className="co-delivery-card-name">Showroom Pickup</div>
                          <div className="co-delivery-card-meta">Anaheim, CA</div>
                        </div>
                        <div className="co-delivery-card-cost">FREE</div>
                      </div>
                      <div className="co-delivery-card-sub">Roma Flooring Designs, 1440 S. State College Blvd.</div>
                      <div className="co-delivery-card-eta">Ready in 3-5 business days</div>
                    </button>
                    <button type="button" className={`co-delivery-card ${!isPickup ? 'selected' : ''}`} onClick={() => { if (typeof setDeliveryMethod === 'function') setDeliveryMethod('shipping'); }}>
                      <div className="co-delivery-card-top">
                        <div>
                          <div className="co-delivery-card-name">Freight</div>
                          <div className="co-delivery-card-meta">Orange County</div>
                        </div>
                        <div className="co-delivery-card-cost">Quoted</div>
                      </div>
                      <div className="co-delivery-card-sub">We deliver within the greater Anaheim area</div>
                      <div className="co-delivery-card-eta">Scheduled after order</div>
                    </button>
                  </div>
                </div>

                {/* Step 03 — Address */}
                <div className={`co-step ${!isPickup && editingAddress ? 'focus' : ''}`}>
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className={`co-step-num ${addressSaved && !editingAddress ? 'saved' : ''}`}>03</span>
                      <h3 className="co-step-title">Address</h3>
                    </div>
                    {!isPickup && addressSaved && !editingAddress && (
                      <div className="co-step-chip">
                        <span className="co-step-chip-label" style={{ color: 'var(--gold)' }}>Saved</span>
                        <button type="button" className="co-step-chip-action" onClick={() => setEditingAddress(true)}>Edit</button>
                      </div>
                    )}
                    {isPickup && (
                      <div className="co-step-chip">
                        <span className="co-step-chip-label" style={{ color: 'var(--gold)' }}>Pickup</span>
                      </div>
                    )}
                  </div>
                  {isPickup ? (
                    <div className="co-pickup-info">
                      <div className="co-pickup-label">Pickup location</div>
                      <div className="co-pickup-name">Roma Flooring Designs</div>
                      <div className="co-pickup-addr">1440 S. State College Blvd., Suite 6M, Anaheim, CA 92806</div>
                      <div className="co-pickup-ready">Ready in 3-5 business days</div>
                    </div>
                  ) : editingAddress ? (
                    <div className="co-form-grid">
                      <div className="co-field">
                        <div className="co-field-label">Address line 1</div>
                        <input ref={addressInputRef} value={line1} onChange={e => setLine1(e.target.value)} placeholder="Start typing an address..." autoComplete="off" />
                      </div>
                      <div className="co-field">
                        <div className="co-field-label">Address line 2</div>
                        <input value={line2} onChange={e => setLine2(e.target.value)} placeholder="Apt, Suite, Unit" />
                      </div>
                      <div className="co-form-row-3">
                        <div className="co-field">
                          <div className="co-field-label">City</div>
                          <input value={city} onChange={e => setCity(e.target.value)} placeholder="Anaheim" />
                        </div>
                        <div className="co-field">
                          <div className="co-field-label">State</div>
                          <select value={state} onChange={e => setState(e.target.value)}>
                            <option value="">Select</option>
                            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className="co-field">
                          <div className="co-field-label">ZIP</div>
                          <input value={zip} onChange={e => setZip(e.target.value)} placeholder="92806" />
                        </div>
                      </div>
                      {addressSaved && (
                        <button type="button" style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--stone-800)', color: 'var(--warm-bg)', border: 'none', font: '500 0.75rem/1 var(--font-body)', letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer' }} onClick={() => setEditingAddress(false)}>Save address</button>
                      )}
                    </div>
                  ) : (
                    <div className="co-address-saved">
                      <div className="co-address-text">{line1}{line2 ? ', ' + line2 : ''}<br />{city}, {state} {zip}</div>
                    </div>
                  )}
                </div>

                {/* Step 04 — Installation quote */}
                <div className={`co-step ${measureRequested ? 'focus' : ''}`}>
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className="co-step-num">04</span>
                      <h3 className="co-step-title">Installation</h3>
                    </div>
                    <div className="co-step-chip">
                      <span className="co-step-chip-label" style={{ color: measureRequested ? 'var(--gold)' : 'var(--warm-muted)' }}>
                        {measureRequested ? 'Requested' : 'Optional'}
                      </span>
                    </div>
                  </div>
                  <label className={`co-measure-toggle ${measureRequested ? 'active' : ''}`}>
                    <div className="co-measure-toggle-left">
                      <div className="co-measure-offer-label">Free estimate</div>
                      <div className="co-measure-offer-title">Get an installation quote</div>
                      <div className="co-measure-offer-sub">We'll measure your space and provide a detailed installation estimate.</div>
                    </div>
                    <div className={`co-toggle-switch ${measureRequested ? 'on' : ''}`} onClick={() => { setMeasureRequested(!measureRequested); if (measureRequested) { setPreferredDate(''); setPreferredTime(''); } }}>
                      <div className="co-toggle-knob" />
                    </div>
                  </label>
                  {measureRequested && (
                    <div className="co-schedule-fields">
                      <div className="co-schedule-row">
                        <div className="co-field">
                          <div className="co-field-label">Preferred date</div>
                          <input type="date" value={preferredDate} onChange={e => setPreferredDate(e.target.value)}
                            min={(() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().split('T')[0]; })()}
                            max={(() => { const d = new Date(); d.setDate(d.getDate() + 60); return d.toISOString().split('T')[0]; })()} />
                        </div>
                        <div className="co-field">
                          <div className="co-field-label">Time window</div>
                          <div className="co-time-slots">
                            {[['morning', 'Morning', '8am – 12pm'], ['afternoon', 'Afternoon', '12 – 4pm'], ['evening', 'Evening', '4 – 7pm']].map(([val, label, sub]) => (
                              <button key={val} type="button" className={`co-time-slot ${preferredTime === val ? 'selected' : ''}`}
                                onClick={() => setPreferredTime(preferredTime === val ? '' : val)}>
                                <span className="co-time-slot-label">{label}</span>
                                <span className="co-time-slot-sub">{sub}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="co-schedule-note">
                        We'll confirm your appointment within 24 hours. Dates subject to availability.
                      </div>
                    </div>
                  )}
                </div>

                {/* Step 05 — Payment */}
                <div className="co-step focus">
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className="co-step-num">05</span>
                      <h3 className="co-step-title">Payment</h3>
                    </div>
                  </div>
                  {walletAvailable && (
                    <div className="co-express-section">
                      {walletMode === 'native' ? (
                        <div id="payment-request-button"></div>
                      ) : (
                        <button type="button" className="co-wallet-btn" onClick={handleSimulatedWalletPay} disabled={processing}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                          {processing ? 'Processing...' : 'Pay with Wallet'}
                          {isLocalDev && <span className="dev-badge">DEV</span>}
                        </button>
                      )}
                      <div className="co-divider">or pay with card</div>
                    </div>
                  )}
                  {savedCards.length > 0 && (
                    <div className="co-saved-cards">
                      {savedCards.map(c => (
                        <label key={c.id} className={'co-saved-card' + (selectedSavedPm === c.id ? ' selected' : '')}>
                          <input type="radio" name="coSavedPm" checked={selectedSavedPm === c.id} onChange={() => setSelectedSavedPm(c.id)} />
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                          <span className="co-saved-card-brand">{c.brand}</span>
                          <span className="co-saved-card-num">&bull;&bull;&bull;&bull; {c.last4}</span>
                          <span className="co-saved-card-exp">Exp {String(c.exp_month).padStart(2, '0')}/{String(c.exp_year).slice(-2)}</span>
                        </label>
                      ))}
                      <label className={'co-saved-card' + (selectedSavedPm === null ? ' selected' : '')}>
                        <input type="radio" name="coSavedPm" checked={selectedSavedPm === null} onChange={() => setSelectedSavedPm(null)} />
                        <span className="co-saved-card-brand">Use a new card</span>
                      </label>
                    </div>
                  )}
                  {/* Card element stays mounted; hidden when paying with a card on file */}
                  <div className="co-card-form" style={{ display: (savedCards.length > 0 && selectedSavedPm) ? 'none' : 'block' }}>
                    <div className="co-stripe-wrap">
                      <div className="co-field-label">Card number</div>
                      <div id="card-element"></div>
                    </div>
                    {customerToken ? (
                      <label className="co-save-card">
                        <input type="checkbox" checked={saveCard} onChange={e => setSaveCard(e.target.checked)} /> Save card for future orders
                      </label>
                    ) : null}
                  </div>
                  <div className="co-divider">or</div>
                  <button type="button" className="co-klarna-btn" onClick={handleKlarnaPay} disabled={processing}>
                    Pay with <span className="co-klarna-word">Klarna.</span>
                  </button>
                  <div className="co-klarna-note">Split into 4 interest-free payments. You'll finish on Klarna, then come right back.</div>
                </div>

                {/* Step 06 — Order notes */}
                <div className="co-step">
                  <div className="co-step-head">
                    <div className="co-step-left">
                      <span className="co-step-num">06</span>
                      <h3 className="co-step-title">Notes</h3>
                    </div>
                    <div className="co-step-chip">
                      <span className="co-step-chip-label" style={{ color: 'var(--warm-muted)' }}>Optional</span>
                    </div>
                  </div>
                  <div className="co-notes">
                    <textarea value={orderNotes} onChange={e => setOrderNotes(e.target.value)} placeholder="Delivery instructions, gate codes, special requests..." />
                    <div className="co-notes-hint">Visible to your project manager</div>
                  </div>
                </div>

                {/* Place order CTA */}
                <button type="submit" className="co-place-order" disabled={processing}>
                  {processing && <span className="co-spinner"></span>}
                  {processing ? 'Processing...' : `Place Order \u2014 $${cartTotal.toFixed(2)}`}
                </button>
                <div className="co-terms">
                  By placing this order you agree to Roma's{' '}
                  <a href="/terms" target="_blank" rel="noopener">terms of service</a> and{' '}
                  <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.
                </div>
              </div>

              {/* RIGHT: Order summary */}
              <div className="co-summary">
                <div className="co-summary-box">
                  <div className="co-summary-header">Order summary</div>
                  <div className="co-summary-items">
                    {cart.map(item => (
                      <div key={item.id} className="co-summary-item">
                        <div className="co-summary-thumb">
                          {item.primary_image ? (
                            <img src={optimizeImg(item.primary_image, 144)} alt="" decoding="async" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <div style={{ width: '100%', height: '100%', background: 'var(--stone-200)' }} />
                          )}
                          {!item.is_sample && <div className="co-summary-thumb-badge">{item.num_boxes}</div>}
                        </div>
                        <div>
                          <div className="co-summary-item-name">{item.product_name || 'Product'}</div>
                          <div className="co-summary-item-detail">
                            {item.is_sample ? 'Free sample' : item.sell_by === 'unit' ? `Qty ${item.num_boxes}` : `${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? 'es' : ''}`}
                          </div>
                        </div>
                        <div className="co-summary-item-price">
                          {item.is_sample ? 'FREE' : '$' + parseFloat(item.subtotal).toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="co-summary-totals">
                    <div className="co-summary-row">
                      <span className="label">Subtotal</span>
                      <span className="value">${productSubtotal.toFixed(2)}</span>
                    </div>
                    {promoDiscount > 0 && (
                      <div className="co-summary-row">
                        <span className="label">Discount{promoInfo && promoInfo.code ? ' · ' + promoInfo.code : ''}</span>
                        <span className="value" style={{ color: '#4a7c3e' }}>&minus;${promoDiscount.toFixed(2)}</span>
                      </div>
                    )}
                    {sampleItems.length > 0 && (
                      <div className="co-summary-row">
                        <span className="label">Sample shipping</span>
                        <span className="value">$12.00</span>
                      </div>
                    )}
                    {taxEstimate.rate > 0 ? (
                      <div className="co-summary-row">
                        <span className="label">Tax ({(taxEstimate.rate * 100).toFixed(2)}%)</span>
                        <span className="value">${estTax.toFixed(2)}</span>
                      </div>
                    ) : (!isPickup && (
                      <div className="co-summary-row">
                        <span className="label">Tax</span>
                        <span className="value" style={{ color: 'var(--stone-500)', fontStyle: 'italic' }}>Calculated with address</span>
                      </div>
                    ))}
                    {isPickup && (
                      <div className="co-summary-row">
                        <span className="label">Delivery</span>
                        <span className="value">Pickup &mdash; Free</span>
                      </div>
                    )}
                  </div>
                  <div className="co-summary-total">
                    <span className="co-summary-total-label">Total</span>
                    <span className="co-summary-total-amount">${cartTotal.toFixed(2)}</span>
                  </div>
                </div>
                <a className="co-summary-edit-cart" href="#" onClick={e => { e.preventDefault(); goCart(); }}>&larr; Edit cart</a>
                <div className="co-summary-trust">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    256-bit TLS encryption
                  </div>
                </div>
              </div>
            </div>
          </form>

          {/* Checkout footer */}
          <div className="co-footer">
            <span>&copy; {new Date().getFullYear()} Roma Flooring Designs</span>
            <div className="co-footer-links">
              <a href="/terms" target="_blank" rel="noopener">Terms</a>
              <a href="/privacy" target="_blank" rel="noopener">Privacy</a>
              <a href="#">Returns</a>
            </div>
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
      const orderTotal = order ? parseFloat(order.total || 0) : 0;

      return (
        <div className="conf-wrap">
          {/* Hero */}
          <div className="conf-hero">
            <div className="conf-check">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h1>Thank You</h1>
            {order && <div className="conf-order-num">Order {order.order_number}</div>}
            <div className="conf-hero-sub">
              Your order has been placed. We&rsquo;ll send a confirmation to your email with tracking details once your order ships.
            </div>
          </div>

          {/* Items ordered */}
          {items.length > 0 && (
            <div className="conf-items">
              <div className="conf-items-header">Items ordered</div>
              {items.map((item, idx) => (
                <div key={idx} className="conf-item">
                  <div className="conf-item-thumb">
                    {item.primary_image ? (
                      <img src={optimizeImg(item.primary_image, 144)} alt="" decoding="async" loading="lazy" />
                    ) : (
                      <div style={{ width: '100%', height: '100%', background: 'var(--stone-200)' }} />
                    )}
                  </div>
                  <div>
                    <div className="conf-item-name">{item.product_name || 'Product'}</div>
                    <div className="conf-item-detail">
                      {item.sell_by === 'unit' ? `Qty ${item.num_boxes}` : `${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? 'es' : ''}`}
                    </div>
                  </div>
                  <div className="conf-item-price">{'$' + parseFloat(item.subtotal || 0).toFixed(2)}</div>
                </div>
              ))}
              <div className="conf-item-total-row">
                <span className="conf-item-total-label">Total paid</span>
                <span className="conf-item-total-amount">${orderTotal.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Sample request */}
          {sampleRequest && (
            <div className="conf-samples">
              <div className="conf-samples-header">
                <span className="conf-samples-badge">Samples</span>
                <span className="conf-samples-title">Request #{sampleRequest.request_number}</span>
              </div>
              {sampleItems.map((item, idx) => (
                <div key={idx} className="conf-sample-item">
                  <span>{item.product_name || 'Product'}{item.variant_name ? ' \u2014 ' + item.variant_name : ''}</span>
                  <span className="conf-sample-free">Free</span>
                </div>
              ))}
              <div style={{ fontSize: '0.8125rem', color: 'var(--warm-muted)', marginTop: '0.75rem' }}>
                Samples ship separately within 2-3 business days.
              </div>
            </div>
          )}

          {/* Details grid */}
          <div className="conf-details">
            <div className="conf-detail-card">
              <div className="conf-detail-label">Delivery</div>
              <div className="conf-detail-title">{order && order.delivery_method === 'pickup' ? 'Showroom Pickup' : 'Freight'}</div>
              <div className="conf-detail-text">
                {order && order.delivery_method === 'pickup'
                  ? '1440 S. State College Blvd., Suite 6M, Anaheim, CA 92806'
                  : order && order.shipping_address ? `${order.shipping_address.line1}, ${order.shipping_address.city}, ${order.shipping_address.state} ${order.shipping_address.zip}` : 'Address on file'
                }
              </div>
              <div className="conf-detail-text" style={{ marginTop: '0.5rem' }}>
                {order && order.delivery_method === 'pickup' ? 'Ready in 3-5 business days' : 'Delivery scheduled after confirmation'}
              </div>
            </div>
            <div className="conf-detail-card">
              <div className="conf-detail-label">Payment</div>
              <div className="conf-detail-title">
                {order && order.card_last4
                  ? (order.card_brand ? order.card_brand.charAt(0).toUpperCase() + order.card_brand.slice(1) + ' ' : 'Card ') + 'ending in ' + order.card_last4
                  : order && order.payment_method === 'klarna' ? 'Klarna'
                  : order && order.payment_method === 'bank_transfer' ? 'Bank transfer' : 'Card payment'}
              </div>
              <div className="conf-detail-text">
                Total charged: ${orderTotal.toFixed(2)}
              </div>
              {order && order.tax_amount > 0 && (
                <div className="conf-detail-text">
                  Includes ${parseFloat(order.tax_amount).toFixed(2)} tax
                </div>
              )}
            </div>
            {order && order.measure_requested && (
              <div className="conf-detail-card">
                <div className="conf-detail-label">Installation quote</div>
                <div className="conf-detail-title">Requested</div>
                <div className="conf-detail-text">
                  {order.preferred_measure_date
                    ? new Date(order.preferred_measure_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
                    : 'Date to be confirmed'}
                  {order.preferred_measure_time && ` \u2014 ${order.preferred_measure_time.charAt(0).toUpperCase() + order.preferred_measure_time.slice(1)}`}
                </div>
                <div className="conf-detail-text" style={{ marginTop: '0.5rem' }}>
                  We'll confirm your appointment within 24 hours.
                </div>
              </div>
            )}
            <div className="conf-detail-card">
              <div className="conf-detail-label">Your contact</div>
              <div className="conf-detail-title">Lia Romano</div>
              <div className="conf-detail-text">
                Project Manager<br />
                lia@romaflooringdesigns.com<br />
                (714) 999-0009
              </div>
              <div className="conf-detail-text" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
                "We'll be in touch within 24 hours."
              </div>
            </div>
          </div>

          {/* Continue shopping */}
          <div className="conf-cta">
            <button className="conf-cta-btn" onClick={goBrowse}>Continue Shopping</button>
          </div>
        </div>
      );
    }

    // ==================== Account Page ====================

    // ==================== Saved Payment Methods (account) ====================
    function PaymentMethodsSection({ customerToken, customer }) {
      const [cards, setCards] = useState(null);
      const [showAdd, setShowAdd] = useState(false);
      const [cardComplete, setCardComplete] = useState(false);
      const [cardError, setCardError] = useState('');
      const [savingCard, setSavingCard] = useState(false);
      const [removing, setRemoving] = useState(null);
      const [msg, setMsg] = useState('');
      const cardElRef = useRef(null);
      const mountRef = useRef(null);
      const authHeaders = { 'X-Customer-Token': customerToken };

      const loadCards = () => {
        fetch(API + '/api/customer/payment-methods', { headers: authHeaders })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => setCards(data.cards || []))
          .catch(() => setCards([]));
      };
      useEffect(loadCards, []);

      // Mount the Stripe card element while the add form is open
      useEffect(() => {
        if (!showAdd || !mountRef.current) return;
        let cancelled = false;
        let card = null;
        ensureStripe().then(stripe => {
          if (cancelled || !stripe || !mountRef.current) return;
          const elements = stripe.elements();
          card = elements.create('card', {
            style: { base: { fontSize: '15px', fontFamily: 'Inter, sans-serif', color: '#292524', '::placeholder': { color: '#a8a29e' } }, invalid: { color: '#dc2626' } }
          });
          card.mount(mountRef.current);
          card.on('change', ev => { setCardComplete(ev.complete); setCardError(ev.error ? ev.error.message : ''); });
          cardElRef.current = card;
        });
        return () => { cancelled = true; if (card) card.destroy(); cardElRef.current = null; setCardComplete(false); };
      }, [showAdd]);

      const saveNewCard = async () => {
        if (!stripeInstance || !cardElRef.current || !cardComplete) return;
        setSavingCard(true); setCardError(''); setMsg('');
        try {
          const r = await fetch(API + '/api/customer/payment-methods/setup-intent', {
            method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }
          });
          const data = await r.json();
          if (!data.client_secret) throw new Error(data.error || 'Could not start card setup');
          const result = await stripeInstance.confirmCardSetup(data.client_secret, {
            payment_method: {
              card: cardElRef.current,
              billing_details: { name: ((customer.first_name || '') + ' ' + (customer.last_name || '')).trim(), email: customer.email }
            }
          });
          if (result.error) throw new Error(result.error.message);
          setShowAdd(false);
          setMsg('Card saved.');
          loadCards();
        } catch (e) {
          setCardError(e.message || 'Failed to save card');
        }
        setSavingCard(false);
      };

      const removeCard = async (pmId) => {
        if (!confirm('Remove this card?')) return;
        setRemoving(pmId);
        try {
          const r = await fetch(API + '/api/customer/payment-methods/' + pmId, { method: 'DELETE', headers: authHeaders });
          if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed to remove card'); }
          setCards(prev => (prev || []).filter(c => c.id !== pmId));
        } catch (e) { alert(e.message || 'Failed to remove card'); }
        setRemoving(null);
      };

      return (
        <div>
          <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', paddingTop: '1.5rem', borderTop: '1px solid var(--stone-200)' }}>Payment Methods</h3>
          {msg && <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.8125rem' }}>{msg}</div>}
          {cards === null ? (
            <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem' }}>Loading saved cards...</p>
          ) : cards.length === 0 && !showAdd ? (
            <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              {'No saved cards yet. Add one here — or check “Save card” at checkout — for faster ordering.'}
            </p>
          ) : null}
          {(cards || []).map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', border: '1px solid var(--stone-200)', padding: '0.75rem 1rem', marginBottom: '0.5rem' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--stone-500)" strokeWidth="1.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
              <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--stone-800)', textTransform: 'capitalize' }}>{c.brand}</span>
              <span style={{ fontSize: '0.875rem', color: 'var(--stone-600)', letterSpacing: '0.08em' }}>{'•••• ' + c.last4}</span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--stone-500)' }}>Exp {String(c.exp_month).padStart(2, '0')}/{String(c.exp_year).slice(-2)}</span>
              <button onClick={() => removeCard(c.id)} disabled={removing === c.id}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8125rem', color: '#b91c1c', fontFamily: 'Inter, sans-serif' }}>
                {removing === c.id ? 'Removing...' : 'Remove'}
              </button>
            </div>
          ))}
          {showAdd ? (
            <div style={{ border: '1px solid var(--stone-200)', padding: '1rem', marginTop: '0.75rem' }}>
              <div style={{ marginBottom: '0.35rem', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--stone-800)' }}>Card details</div>
              <div style={{ border: '1px solid var(--stone-200)', padding: '0.75rem', background: '#fff' }}>
                <div ref={mountRef}></div>
              </div>
              {cardError && <div style={{ color: '#b91c1c', fontSize: '0.8125rem', marginTop: '0.5rem' }}>{cardError}</div>}
              <p style={{ fontSize: '0.75rem', color: 'var(--stone-500)', margin: '0.75rem 0' }}>
                {'Stored securely with Stripe — your card number never touches our servers.'}
              </p>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn" onClick={saveNewCard} disabled={!cardComplete || savingCard}>
                  {savingCard ? 'Saving...' : 'Save Card'}
                </button>
                <button onClick={() => { setShowAdd(false); setCardError(''); }} disabled={savingCard}
                  style={{ background: 'none', border: '1px solid var(--stone-300)', padding: '0 1.25rem', cursor: 'pointer', fontSize: '0.875rem', fontFamily: 'Inter, sans-serif', color: 'var(--stone-700)' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="btn" onClick={() => { setMsg(''); setShowAdd(true); }} style={{ marginTop: '0.25rem', marginBottom: '1rem' }}>+ Add a Card</button>
          )}
        </div>
      );
    }

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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { setOrders(data.orders || []); setLoadingOrders(false); })
          .catch(() => setLoadingOrders(false));
        fetch(API + '/api/customer/sample-requests', { headers: authHeaders })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { setSampleRequests(data.sample_requests || []); setLoadingSamples(false); })
          .catch(() => setLoadingSamples(false));
        fetch(API + '/api/customer/quotes', { headers: authHeaders })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { setQuotes(data.quotes || []); setLoadingQuotes(false); })
          .catch(() => setLoadingQuotes(false));
        fetch(API + '/api/customer/visits', { headers: authHeaders })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => { setVisits(data.visits || []); setLoadingVisits(false); })
          .catch(() => setLoadingVisits(false));
      }, []);

      const refreshSamples = () => {
        fetch(API + '/api/customer/sample-requests', { headers: authHeaders })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
        } catch(e) { setSampleSearchResults([]); }
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
        } catch(e) { alert('Failed to add sample'); }
        setAddingSampleItem(null);
      };

      const viewOrderDetail = async (orderId) => {
        if (expandedOrder === orderId) { setExpandedOrder(null); setOrderDetail(null); return; }
        setExpandedOrder(orderId);
        try {
          const resp = await fetch(API + '/api/customer/orders/' + orderId, { headers: authHeaders });
          const data = await resp.json();
          setOrderDetail(data);
        } catch(e) { setOrderDetail(null); }
      };

      const viewQuoteDetail = async (quoteId) => {
        if (expandedQuote === quoteId) { setExpandedQuote(null); setQuoteDetail(null); return; }
        setExpandedQuote(quoteId);
        try {
          const resp = await fetch(API + '/api/customer/quotes/' + quoteId, { headers: authHeaders });
          const data = await resp.json();
          setQuoteDetail(data);
        } catch(e) { setQuoteDetail(null); }
      };

      const viewVisitDetail = async (visitId) => {
        if (expandedVisit === visitId) { setExpandedVisit(null); setVisitDetail(null); return; }
        setExpandedVisit(visitId);
        try {
          const resp = await fetch(API + '/api/customer/visits/' + visitId, { headers: authHeaders });
          const data = await resp.json();
          setVisitDetail(data);
        } catch(e) { setVisitDetail(null); }
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
        } catch(e) { setProfileError('Failed to save.'); }
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
        } catch(e) { setPwError('Failed to update password.'); }
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
                                    <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image, 100)} alt={item.product_name} style={{ width: 40, height: 40, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />
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
                                          {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 100)} alt="" style={{ width: 32, height: 32, objectFit: 'cover' }} loading="lazy" />}
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
                                  <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image, 100)} alt={item.product_name} style={{ width: 48, height: 48, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />
                                )}
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 500 }}>{item.product_name}</div>
                                  {item.collection && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.collection}</div>}
                                  {item.variant_name && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.variant_name}</div>}
                                </div>
                                {skuListPrice(item) && (
                                  <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
                                    ${displayPrice(item, skuListPrice(item)).toFixed(2)}{priceSuffix(item)}
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

              <PaymentMethodsSection customerToken={customerToken} customer={customer} />

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
        // Fetch wishlisted SKUs by sku_id filter
        const skuIds = wishlist.join(',');
        fetch(API + '/api/storefront/skus?sku_ids=' + encodeURIComponent(skuIds) + '&limit=' + wishlist.length)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => {
            const all = data.skus || [];
            // Keep only SKUs that are in the wishlist, in wishlist order
            const skuMap = new Map();
            all.forEach(sku => skuMap.set(sku.sku_id, sku));
            const wishlisted = wishlist.map(id => skuMap.get(id)).filter(Boolean);
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
                          {rv.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(rv.primary_image, 400)} alt={rv.product_name} loading="lazy" />}
                        </div>
                        <div className="sibling-card-name">{fullProductName(rv)}</div>
                        {skuListPrice(rv) && <div className="sibling-card-price">${displayPrice(rv, skuListPrice(rv)).toFixed(2)}{priceSuffix(rv)}</div>}
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
                  onToggleWishlist={() => toggleWishlist(sku.sku_id)} />
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
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => { setDashData(d); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'orders') {
          Promise.all([
            fetch(API + '/api/trade/orders', { headers: authHeaders }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
            fetch(API + '/api/trade/projects', { headers: authHeaders }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(() => ({ projects: [] }))
          ]).then(([od, pd]) => { setOrders(od.orders || []); setProjects(pd.projects || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'projects') {
          fetch(API + '/api/trade/projects', { headers: authHeaders })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => { setProjects(d.projects || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'favorites') {
          fetch(API + '/api/trade/favorites', { headers: authHeaders })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => { setFavorites(d.collections || []); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'quotes') {
          fetch(API + '/api/trade/quotes', { headers: authHeaders })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => { setQuotes(d.quotes || []); setExpandedQuote(null); setQuoteDetail(null); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'visits') {
          fetch(API + '/api/trade/visits', { headers: authHeaders })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => { setVisits(d.visits || []); setExpandedVisit(null); setVisitDetail(null); setLoading(false); }).catch(() => setLoading(false));
        } else if (t === 'account') {
          Promise.all([
            fetch(API + '/api/trade/account', { headers: authHeaders }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
            fetch(API + '/api/trade/membership', { headers: authHeaders }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(() => ({})),
            fetch(API + '/api/trade/my-rep', { headers: authHeaders }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(() => ({}))
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

      const downloadQuotePdf = async (quoteId) => {
        try {
          const r = await fetch(API + '/api/trade/quotes/' + quoteId + '/pdf', { headers: { 'X-Trade-Token': tradeToken } });
          if (!r.ok) throw new Error('Failed to load PDF');
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (e) { console.error(e); }
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
                                            {item.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image, 100)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', border: '1px solid var(--stone-200)' }} loading="lazy" />}
                                          </td>
                                          <td style={{ padding: '0.5rem' }}>
                                            <div style={{ fontWeight: 500 }}>{item.product_name}</div>
                                            {item.collection && <div style={{ fontSize: '0.75rem', color: 'var(--stone-500)' }}>{item.collection}</div>}
                                          </td>
                                          <td style={{ padding: '0.5rem', color: 'var(--stone-600)' }}>{item.variant_name || '\u2014'}</td>
                                          <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                                            {skuListPrice(item) ? `$${displayPrice(item, skuListPrice(item)).toFixed(2)}${priceSuffix(item)}` : '\u2014'}
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
                              {item.primary_image_url ? <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image_url, 400)} alt={item.product_name} loading="lazy" decoding="async" /> : <div style={{ height: 140, background: 'var(--stone-100)' }}></div>}
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
                    {c.image && <img onLoad={handleProductImgLoad} src={optimizeImg(c.image, 400)} alt={c.name} loading="lazy" decoding="async" />}
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
      useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

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
                          {sku.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(sku.primary_image, 400)} alt={sku.product_name} loading="lazy" decoding="async" />}
                          <div className="quiz-result-card-info">
                            <div className="quiz-result-card-name">{sku.product_name}</div>
                            <div className="quiz-result-card-price">{skuListPrice(sku) ? '$' + displayPrice(sku, skuListPrice(sku)).toFixed(2) + priceSuffix(sku) : ''}</div>
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
      useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);
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
          if (!resp.ok) { const errData = await resp.json().catch(() => ({})); setError(errData.error || 'Upload failed'); setUploading(''); return; }
          const data = await resp.json();
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
        let timerId = null;
        if (step === 3 && !cardMounted.current && setupIntentSecret && stripeInstance) {
          timerId = setTimeout(() => {
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
          if (timerId) clearTimeout(timerId);
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
                  Don't have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('register'); setError(''); setSuccess(''); }}>Apply for Trade</a>
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
                      Already have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('login'); setError(''); setSuccess(''); setStep(1); }}>Sign In</a>
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

    // ── Google Sign-In Button ──
    function GoogleSignInButton({ onCredentialResponse }) {
      const containerRef = useRef(null);
      const [ready, setReady] = useState(false);
      const [clientId, setClientId] = useState(null);
      useEffect(() => {
        fetch(API + "/api/config/google-client-id").then(r => r.json()).then(data => {
          if (data.clientId) setClientId(data.clientId);
        }).catch(() => {});
      }, []);
      useEffect(() => {
        if (!clientId || !containerRef.current) return;
        const tryInit = () => {
          if (typeof google === "undefined" || !google.accounts || !google.accounts.id) return false;
          try {
            google.accounts.id.initialize({
              client_id: clientId,
              callback: (response) => { if (response.credential) onCredentialResponse(response.credential); },
              auto_select: false,
              context: "signin"
            });
            google.accounts.id.renderButton(containerRef.current, {
              type: "standard",
              theme: "outline",
              size: "large",
              text: "continue_with",
              shape: "rectangular",
              width: containerRef.current.offsetWidth || 340
            });
            setReady(true);
          } catch (e) { console.warn("Google Sign-In init error:", e); }
          return true;
        };
        if (tryInit()) return;
        const interval = setInterval(() => { if (tryInit()) clearInterval(interval); }, 200);
        const timeout = setTimeout(() => clearInterval(interval), 8000);
        return () => { clearInterval(interval); clearTimeout(timeout); };
      }, [clientId]);
      if (!clientId) return null;
      return /* @__PURE__ */ React.createElement("div", { className: "google-signin-container", ref: containerRef, style: ready ? {} : { minHeight: 44 } });
    }

    function useGoogleAuth(onLogin) {
      const [googleError, setGoogleError] = useState("");
      const [googleLoading, setGoogleLoading] = useState(false);
      const handleGoogleCredential = async (credential) => {
        setGoogleError("");
        setGoogleLoading(true);
        try {
          const res = await fetch(API + "/api/customer/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setGoogleError(data.error || "Google sign-in failed.");
            setGoogleLoading(false);
            return;
          }
          onLogin(data.token, data.customer, true);
        } catch (e) {
          setGoogleError("Google sign-in failed. Please try again.");
          setGoogleLoading(false);
        }
      };
      return { handleGoogleCredential, googleError, googleLoading };
    }

    // ── Full-page auth shell (two-column: form left, editorial right) ──
    function AuthPageShell({ children, panelKind, panelTone, panelImage, panelEyebrow, panelHeadline, panelSub, panelAttribution, goHome }) {
      const bgStyle = panelImage
        ? { backgroundImage: 'url(' + panelImage + ')', backgroundSize: 'cover', backgroundPosition: 'center' }
        : materialFace(panelKind, panelTone);
      return /* @__PURE__ */ React.createElement("div", { className: "auth-page" },
        /* @__PURE__ */ React.createElement("div", { className: "auth-form-col" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-header" },
            /* @__PURE__ */ React.createElement("a", { className: "auth-header-logo", onClick: goHome }, "Roma"),
            /* @__PURE__ */ React.createElement("span", { className: "auth-header-tagline" }, "Anaheim, CA \xb7 Since 1999")
          ),
          /* @__PURE__ */ React.createElement("div", { className: "auth-form-col-inner" }, children),
          /* @__PURE__ */ React.createElement("div", { className: "auth-footer" },
            /* @__PURE__ */ React.createElement("span", null, "\xa9 2026 Roma Flooring Designs"),
            /* @__PURE__ */ React.createElement("span", { className: "auth-footer-links" },
              /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "Privacy"),
              /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms"),
              /* @__PURE__ */ React.createElement("a", null, "Help")
            )
          )
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-panel" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-panel-bg", style: bgStyle }),
          /* @__PURE__ */ React.createElement("div", { className: "auth-panel-overlay" }),
          /* @__PURE__ */ React.createElement("div", { className: "auth-panel-eyebrow" }, panelEyebrow),
          /* @__PURE__ */ React.createElement("div", { className: "auth-panel-content" },
            /* @__PURE__ */ React.createElement("h2", { className: "auth-panel-headline" }, panelHeadline),
            panelSub && /* @__PURE__ */ React.createElement("p", { className: "auth-panel-sub" }, panelSub),
            panelAttribution && /* @__PURE__ */ React.createElement("div", { className: "auth-panel-attribution" }, panelAttribution)
          )
        )
      );
    }

    // ── Sign In Full Page ──
    function SignInFullPage({ onLogin, goHome, navigate }) {
      const [email, setEmail] = useState("");
      const [password, setPassword] = useState("");
      const [remember, setRemember] = useState(true);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);
      const { handleGoogleCredential, googleError, googleLoading } = useGoogleAuth(onLogin);
      const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
          const res = await fetch(API + "/api/customer/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            if (data.error === "password_not_set") {
              setError("__password_not_set__");
            } else {
              setError(data.error || "Invalid email or password.");
            }
            setLoading(false);
            return;
          }
          onLogin(data.token, data.customer, remember);
        } catch (e2) { setError("Unable to sign in. Please try again."); setLoading(false); }
      };
      return /* @__PURE__ */ React.createElement(AuthPageShell, {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1659362549741-c32157cc71f4?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Colonnata \xb7 Massa-Carrara, Italy",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Two and a half thousand SKUs, ", /* @__PURE__ */ React.createElement("em", null, "one cart"), "."),
        panelSub: "Sign in to pick up your saved quote, track your slab, or message your rep. Your account moves with you \u2014 phone, laptop, showroom."
      },
        /* @__PURE__ */ React.createElement("div", null,
          /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Welcome back"),
          /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Sign in")
        ),
        error && (error === "__password_not_set__" ? /* @__PURE__ */ React.createElement("div", { className: "auth-error" },
          "Your account was created in our showroom. ",
          /* @__PURE__ */ React.createElement("a", { style: { fontWeight: 600, textDecoration: "underline", cursor: "pointer" }, onClick: () => navigate("/signup") }, "Create a password"),
          " to get started, or check your email for a welcome link."
        ) : /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error)),
        /* @__PURE__ */ React.createElement(GoogleSignInButton, { onCredentialResponse: handleGoogleCredential }),
        googleError && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, googleError),
        googleLoading && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", fontSize: "0.8125rem", color: "var(--stone-500)" } }, "Signing in with Google\u2026"),
        /* @__PURE__ */ React.createElement("div", { className: "auth-divider" },
          /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" }),
          "or sign in with email",
          /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" })
        ),
        /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Email"),
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-row" },
              /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
            )
          ),
          /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Password"),
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-row" },
              /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "current-password" }),
              /* @__PURE__ */ React.createElement("a", { className: "auth-field-right", onClick: () => navigate("/forgot-password") }, "Forgot? \u2192")
            )
          ),
          /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 14 } },
            /* @__PURE__ */ React.createElement("label", { className: "auth-checkbox", onClick: (e) => { e.preventDefault(); setRemember(!remember); } },
              /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-box" + (remember ? " checked" : "") },
                remember && /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-check" }, "\u2713")
              ),
              "Keep me signed in on this device"
            ),
            /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Signing in\u2026" : "Sign in \u2192")
          )
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-link-row" },
          /* @__PURE__ */ React.createElement("span", null, "New to Roma?"),
          /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signup") }, "Create an account \u2192")
        )
      );
    }

    // ── Sign Up Full Page ──
    function SignUpFullPage({ onLogin, goHome, navigate }) {
      const [path, setPath] = useState("homeowner");
      const [firstName, setFirstName] = useState("");
      const [lastName, setLastName] = useState("");
      const [email, setEmail] = useState("");
      const [password, setPassword] = useState("");
      const [newsletter, setNewsletter] = useState(false);
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);
      const { handleGoogleCredential, googleError, googleLoading } = useGoogleAuth(onLogin);
      const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) { setError("Password must be at least 8 characters with 1 uppercase letter and 1 number."); return; }
        setLoading(true);
        try {
          const res = await fetch(API + "/api/customer/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, first_name: firstName, last_name: lastName, newsletter })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) { setError(data.error || "Registration failed."); setLoading(false); return; }
          onLogin(data.token, data.customer, true);
        } catch (e2) { setError("Unable to create account. Please try again."); setLoading(false); }
      };
      return /* @__PURE__ */ React.createElement(AuthPageShell, {
        goHome,
        panelImage: "https://plus.unsplash.com/premium_photo-1661902468735-eabf780f8ff6?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Marble \xb7 Luxury Bath",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "One account, ", /* @__PURE__ */ React.createElement("em", null, "two paths"), "."),
        panelSub: "If you\u2019re shopping for your own home, you\u2019ll be checking out in under a minute. If you\u2019re putting materials in other people\u2019s houses, the trade path unlocks pricing, a dedicated project manager, and the spec library."
      },
        /* @__PURE__ */ React.createElement("div", null,
          /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Create your account"),
          /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Pick a path")
        ),
        error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
        /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 10 } },
          /* @__PURE__ */ React.createElement("label", { className: "auth-path-option" + (path === "homeowner" ? " selected" : ""), onClick: () => setPath("homeowner") },
            /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio" },
              path === "homeowner" && /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio-dot" })
            ),
            /* @__PURE__ */ React.createElement("div", null,
              /* @__PURE__ */ React.createElement("div", { className: "auth-path-title" }, "Homeowner"),
              /* @__PURE__ */ React.createElement("div", { className: "auth-path-sub" }, "Shopping for your own home. 30-second sign-up.")
            ),
            /* @__PURE__ */ React.createElement("span", { className: "auth-path-tag", style: { color: "var(--gold)", borderColor: "rgba(168,121,53,0.33)" } }, "Fast")
          ),
          /* @__PURE__ */ React.createElement("label", { className: "auth-path-option" + (path === "trade" ? " selected" : ""), onClick: () => setPath("trade") },
            /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio" },
              path === "trade" && /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio-dot" })
            ),
            /* @__PURE__ */ React.createElement("div", null,
              /* @__PURE__ */ React.createElement("div", { className: "auth-path-title" }, "Trade pro"),
              /* @__PURE__ */ React.createElement("div", { className: "auth-path-sub" }, "Designer, contractor, builder, installer. Goes through application.")
            ),
            /* @__PURE__ */ React.createElement("span", { className: "auth-path-tag", style: { color: "var(--warm-muted)", borderColor: "rgba(138,126,104,0.33)" } }, "Apply")
          )
        ),
        path === "homeowner" ? /* @__PURE__ */ React.createElement(React.Fragment, null,
          /* @__PURE__ */ React.createElement(GoogleSignInButton, { onCredentialResponse: handleGoogleCredential }),
          googleError && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, googleError),
          googleLoading && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", fontSize: "0.8125rem", color: "var(--stone-500)" } }, "Signing in with Google\u2026"),
          /* @__PURE__ */ React.createElement("div", { className: "auth-divider" },
            /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" }),
            "or sign up with email",
            /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" })
          ),
          /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-2col" },
              /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
                /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "First name"),
                /* @__PURE__ */ React.createElement("input", { type: "text", value: firstName, onChange: (e) => setFirstName(e.target.value), placeholder: "First", required: true, autoComplete: "given-name" })
              ),
              /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
                /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Last name"),
                /* @__PURE__ */ React.createElement("input", { type: "text", value: lastName, onChange: (e) => setLastName(e.target.value), placeholder: "Last", required: true, autoComplete: "family-name" })
              )
            ),
            /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
              /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Email"),
              /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
            ),
            /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
              /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Password"),
              /* @__PURE__ */ React.createElement("div", { className: "auth-field-row" },
                /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true, autoComplete: "new-password" }),
                /* @__PURE__ */ React.createElement("span", { className: "auth-field-hint" }, "8+ chars, 1 uppercase, 1 number")
              )
            ),
            /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 14 } },
              /* @__PURE__ */ React.createElement("label", { className: "auth-checkbox", onClick: (e) => { e.preventDefault(); setNewsletter(!newsletter); } },
                /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-box" + (newsletter ? " checked" : "") },
                  newsletter && /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-check" }, "\u2713")
                ),
                /* @__PURE__ */ React.createElement("span", null, "Send me Roma\u2019s monthly field guide \u2014 install math, new arrivals, showroom notes. No daily emails. Unsubscribe whenever.")
              ),
              /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Creating account\u2026" : "Create my account \u2192"),
              /* @__PURE__ */ React.createElement("div", { className: "auth-terms" },
                "By signing up you agree to Roma\u2019s ", /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms of service"),
                " and acknowledge our ", /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "privacy practices"), "."
              )
            )
          )
        ) : /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 18, paddingTop: 12, borderTop: "0.5px solid rgba(28,25,23,0.13)" } },
          /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "The trade application takes about 5 minutes. You\u2019ll need your business license and a brief description of your work."),
          /* @__PURE__ */ React.createElement("button", { type: "button", className: "auth-cta", onClick: () => navigate("/trade") }, "Start trade application \u2192")
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-link-row" },
          /* @__PURE__ */ React.createElement("span", null, "Already have an account?"),
          /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "Sign in \u2192")
        )
      );
    }

    // ── Set Password Page (welcome email flow) ──
    function SetPasswordPage({ onLogin, goHome, navigate }) {
      const [newPassword, setNewPassword] = useState("");
      const [confirmPassword, setConfirmPassword] = useState("");
      const [error, setError] = useState("");
      const [loading, setLoading] = useState(false);
      const [expired, setExpired] = useState(false);
      const token = new URLSearchParams(window.location.search).get("token");
      const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }
        if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
          setError("Password must be at least 8 characters with 1 uppercase letter and 1 number.");
          return;
        }
        setLoading(true);
        try {
          const resp = await fetch(API + "/api/customer/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, new_password: newPassword })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            if (resp.status === 400 && /expired|invalid/i.test(data.error || "")) {
              setExpired(true);
            } else {
              setError(data.error || "Something went wrong.");
            }
            setLoading(false);
            return;
          }
          window.history.replaceState({}, "", "/account");
          if (data.token && data.customer) {
            onLogin(data.token, data.customer, true);
          }
        } catch (e2) { setError("Something went wrong. Please try again."); setLoading(false); }
      };
      return /* @__PURE__ */ React.createElement(AuthPageShell, {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1659362549741-c32157cc71f4?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Colonnata \xb7 Massa-Carrara, Italy",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Your order is in. ", /* @__PURE__ */ React.createElement("em", null, "Now make it yours"), "."),
        panelSub: "Set a password to track your order, view invoices, reorder materials, and message your rep \u2014 all from one account."
      },
        /* @__PURE__ */ React.createElement("div", null,
          /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Welcome to Roma"),
          /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Set your password")
        ),
        /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "Your account was created when you visited our showroom. Set a password to view your orders and manage your account online."),
        error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
        expired ? /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 18 } },
          /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, "This link has expired. You can create a password by signing up with the same email address used for your order."),
          /* @__PURE__ */ React.createElement("button", { type: "button", className: "auth-cta", onClick: () => navigate("/signup") }, "Create account \u2192")
        ) : /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "New password"),
            /* @__PURE__ */ React.createElement("input", { type: "password", value: newPassword, onChange: (e) => setNewPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "new-password" })
          ),
          /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Confirm password"),
            /* @__PURE__ */ React.createElement("input", { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "new-password" })
          ),
          /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", margin: 0 } }, "8+ characters, 1 uppercase letter, 1 number"),
          /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Setting password\u2026" : "Set password \u2192")
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-link-row" },
          /* @__PURE__ */ React.createElement("span", null, "Already have a password?"),
          /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "Sign in \u2192")
        )
      );
    }

    // ── Forgot Password Full Page ──
    function ForgotPasswordFullPage({ goHome, navigate }) {
      const [email, setEmail] = useState("");
      const [error, setError] = useState("");
      const [sent, setSent] = useState(false);
      const [loading, setLoading] = useState(false);
      const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
          const res = await fetch(API + "/api/customer/forgot-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) { setError(data.error || "Unable to send reset email."); setLoading(false); return; }
          setSent(true);
          setLoading(false);
        } catch (e2) { setError("Unable to send reset email. Please try again."); setLoading(false); }
      };
      return /* @__PURE__ */ React.createElement(AuthPageShell, {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1661107259637-4e1c55462428?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Stone Tile \xb7 Modern Bath",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Locked out? ", /* @__PURE__ */ React.createElement("em", null, "We\u2019ll send a link"), "."),
        panelSub: "Your cart, quotes, and project files stay safe in the meantime. The reset link expires in 30 minutes \u2014 if you don\u2019t see it, check the spam folder or write to Sales@romaflooringdesigns.com."
      },
        /* @__PURE__ */ React.createElement("div", null,
          /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Reset password"),
          /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Forgot it?", /* @__PURE__ */ React.createElement("br", null), "Happens.")
        ),
        /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "Enter the email on your Roma account. We\u2019ll send a reset link that\u2019s good for 30 minutes."),
        error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
        /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Account email"),
            /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
          ),
          /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading || sent }, loading ? "Sending\u2026" : "Send reset link \u2192")
        ),
        sent && /* @__PURE__ */ React.createElement("div", { className: "auth-confirm-banner" },
          /* @__PURE__ */ React.createElement("span", { className: "auth-confirm-icon" }, "\u2713"),
          /* @__PURE__ */ React.createElement("div", null,
            /* @__PURE__ */ React.createElement("div", { className: "auth-confirm-title" }, "Reset link sent to " + email),
            /* @__PURE__ */ React.createElement("div", { className: "auth-confirm-sub" }, "Check your inbox. Didn\u2019t arrive within 5 minutes? ",
              /* @__PURE__ */ React.createElement("a", { onClick: () => { setSent(false); setLoading(false); } }, "Resend"),
              " or check spam."
            )
          )
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-link-row" },
          /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "\u2190 Back to sign in"),
          /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => window.location.href = "mailto:Sales@romaflooringdesigns.com" }, "Write to support \u2192")
        )
      );
    }


    function CustomerAuthModal({ onClose, onLogin, initialMode }) {
      const [mode, setMode] = useState(initialMode || 'login');
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [firstName, setFirstName] = useState('');
      const [lastName, setLastName] = useState('');
      const [error, setError] = useState('');
      const [success, setSuccess] = useState('');
      const [loading, setLoading] = useState(false);
      const { handleGoogleCredential, googleError, googleLoading } = useGoogleAuth(onLogin);
      useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

      const handleLogin = async (e) => {
        e.preventDefault();
        setError(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) { setError(data.error || 'Login failed'); setLoading(false); return; }
          onLogin(data.token, data.customer);
        } catch(e) { setError('Login failed'); setLoading(false); }
      };

      const handleRegister = async (e) => {
        e.preventDefault();
        setError(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, first_name: firstName, last_name: lastName })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) { setError(data.error || 'Registration failed'); setLoading(false); return; }
          onLogin(data.token, data.customer);
        } catch(e) { setError('Registration failed'); setLoading(false); }
      };

      const handleForgotPassword = async (e) => {
        e.preventDefault();
        setError(''); setSuccess(''); setLoading(true);
        try {
          const res = await fetch(API + '/api/customer/forgot-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) { setError(data.error || 'Unable to send reset email. Please try again.'); setLoading(false); return; }
          setSuccess('If an account exists with that email, a reset link has been sent.');
          setLoading(false);
        } catch(e) { setError('Unable to send reset email. Please try again.'); setLoading(false); }
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
                  <a href="#" onClick={e => { e.preventDefault(); switchMode('login'); }} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Back to Sign In</a>
                </div>
              </>
            ) : (
              <>
                {mode === 'login' && (
                  <>
                    <GoogleSignInButton onCredentialResponse={handleGoogleCredential} />
                    {googleError && <div className="checkout-error">{googleError}</div>}
                    {googleLoading && <div style={{ textAlign: 'center', fontSize: '0.8125rem', color: 'var(--stone-500)', marginBottom: '0.5rem' }}>Signing in with Google…</div>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '1rem 0', fontSize: '0.8125rem', color: 'var(--stone-400)' }}>
                      <span style={{ flex: 1, borderBottom: '1px solid var(--stone-200)' }} />
                      or
                      <span style={{ flex: 1, borderBottom: '1px solid var(--stone-200)' }} />
                    </div>
                  </>
                )}
                <form onSubmit={mode === 'login' ? handleLogin : handleRegister}>
                  {error && <div className="checkout-error">{error}</div>}
                  {mode === 'register' && (
                    <div className="checkout-row">
                      <div className="checkout-field"><label>First Name</label><input className="checkout-input" value={firstName} onChange={e => setFirstName(e.target.value)} required /></div>
                      <div className="checkout-field"><label>Last Name</label><input className="checkout-input" value={lastName} onChange={e => setLastName(e.target.value)} required /></div>
                    </div>
                  )}
                  <div className="checkout-field"><label>Email</label><input className="checkout-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
                  <div className="checkout-field"><label>Password</label><input className="checkout-input" type="password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
                  {mode === 'login' && (
                    <div style={{ textAlign: 'right', marginBottom: '1rem' }}>
                      <a href="#" onClick={e => { e.preventDefault(); switchMode('forgot'); }} style={{ fontSize: '0.8125rem', color: 'var(--gold)', cursor: 'pointer' }}>Forgot password?</a>
                    </div>
                  )}
                  <button type="submit" className="btn" style={{ width: '100%' }} disabled={loading}>
                    {loading ? '...' : (mode === 'login' ? 'Sign In' : 'Create Account')}
                  </button>
                </form>
                <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.875rem' }}>
                  {mode === 'login' ? (
                    <span>No account? <a href="#" onClick={e => { e.preventDefault(); switchMode('register'); }} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Create one</a></span>
                  ) : (
                    <span>Have an account? <a href="#" onClick={e => { e.preventDefault(); switchMode('login'); }} style={{ color: 'var(--gold)', cursor: 'pointer' }}>Sign in</a></span>
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
      useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

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
        } catch(e) { setError('Unable to submit. Please try again.'); }
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
                    <div className="checkout-field"><label>Phone *</label><input className="checkout-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} required /></div>
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
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(data => setStats(data))
          .catch(() => {});
      }, []);

      useEffect(() => {
        setLoading(true);
        const offset = (page - 1) * limit;
        fetch(`/api/storefront/skus?sale=true&sort=${sortBy}&limit=${limit}&offset=${offset}`)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
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
                  {item.primary_image && <img onLoad={handleProductImgLoad} src={optimizeImg(item.primary_image, 400)} alt={item.product_name} loading="lazy" decoding="async" />}
                </div>
                <div className="sku-card-name">{fullProductName(item)}</div>
                <div className="sku-card-price">
                  {skuListPrice(item) ? '$' + displayPrice(item, skuListPrice(item)).toFixed(2) + priceSuffix(item) : ''}
                </div>
                {item.rep_note && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', fontStyle: 'italic', color: 'var(--stone-400)', lineHeight: 1.4 }}>"{item.rep_note}"</p>
                )}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', paddingTop: '2rem', borderTop: '1px solid var(--stone-200)' }}>
            <p style={{ color: 'var(--stone-500)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Questions? Contact us at (714) 999-0009</p>
            <p style={{ color: 'var(--stone-400)', fontSize: '0.8125rem' }}>Roma Flooring Designs &middot; 1440 S. State College Blvd Suite 6M, Anaheim, CA 92806</p>
          </div>
        </div>
      );
    }

    // ==================== Reset Password Page ====================

    function ResetPasswordPage({ goHome, openLogin, onLogin }) {
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
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) { setError(data.error || 'Something went wrong.'); setLoading(false); return; }
          setSuccess(true);
          window.history.replaceState({}, '', window.location.pathname);
          if (data.token && data.customer && onLogin) {
            onLogin(data.token, data.customer, true);
            return;
          }
        } catch(e) { setError('Something went wrong.'); }
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
                <a href="#" onClick={e => { e.preventDefault(); item.onClick(); }}>{item.label}</a>
              ) : (
                <span style={{ color: 'var(--stone-800)' }}>{item.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      );
    }

    // ==================== Cookie Consent Notice ====================
    // Notice-at-collection / cookie consent bar. Records the visitor's choice in
    // localStorage so it shows once; 'declined' broadcasts a 'cookie-consent'
    // event that non-essential tracking can listen for to stay off.
    function CookieConsent({ navigate }) {
      const [visible, setVisible] = useState(false);
      useEffect(() => {
        try { if (!localStorage.getItem('cookie_consent')) setVisible(true); } catch (e) {}
      }, []);
      const choose = (choice) => {
        try {
          localStorage.setItem('cookie_consent', choice);
          localStorage.setItem('cookie_consent_at', new Date().toISOString());
        } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('cookie-consent', { detail: choice })); } catch (e) {}
        setVisible(false);
      };
      if (!visible) return null;
      return (
        <div role="dialog" aria-label="Cookie notice" style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 10000,
          background: 'var(--stone-900)', color: 'var(--stone-50)',
          padding: '1.125rem 1.25rem', boxShadow: '0 -4px 28px rgba(0,0,0,0.22)'
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem 1.5rem', maxWidth: 1200, margin: '0 auto' }}>
            <p style={{ flex: '1 1 300px', margin: 0, fontSize: '0.8125rem', lineHeight: 1.55, color: 'rgba(250,250,249,0.85)' }}>
              We use cookies to keep your cart and session working, remember your preferences, and understand how our site is used. By clicking “Accept,” you agree to this use. You can decline non-essential cookies at any time. See our{' '}
              <a href="/privacy" onClick={e => { e.preventDefault(); if (navigate) navigate('/privacy'); }} style={{ color: 'var(--gold-light)', textDecoration: 'underline' }}>Privacy Policy</a>.
            </p>
            <div style={{ display: 'flex', gap: '0.625rem', flexShrink: 0 }}>
              <button type="button" onClick={() => choose('declined')} style={{
                padding: '0.625rem 1.25rem', background: 'transparent', color: 'var(--stone-50)',
                border: '0.5px solid rgba(250,250,249,0.35)', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'var(--font-body)', fontSize: '0.8125rem', fontWeight: 500
              }}>Decline</button>
              <button type="button" onClick={() => choose('accepted')} style={{
                padding: '0.625rem 1.5rem', background: 'var(--gold)', color: 'var(--stone-900)',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'var(--font-body)', fontSize: '0.8125rem', fontWeight: 600
              }}>Accept</button>
            </div>
          </div>
        </div>
      );
    }

    // ==================== Legal Pages (Terms / Privacy) ====================
    // Scaffold with placeholder copy. The prose below is a starting structure —
    // it MUST be replaced with counsel-approved language before relying on it.
    function LegalPage({ kind, goHome, navigate }) {
      const isTerms = kind === 'terms';
      const title = isTerms ? 'Terms of Service' : 'Privacy Policy';
      const termsSections = [
        { h: '1. Acceptance of Terms', p: 'By accessing this site, requesting a quote, or placing an order with Roma Flooring Designs (“Roma,” “we,” or “us”), you acknowledge that you have read, understood, and agree to be bound by these Terms of Service. These Terms govern every sale and take precedence over any conflicting terms in your purchase documents unless we expressly agree otherwise in writing. If you do not agree, please do not use this site or purchase from us.' },
        { h: '2. Natural Materials & Variation', p: 'Stone, tile, wood, and other natural or nature-derived products are products of nature. Variation in color, veining, shade, tone, texture, finish, size, and marking is normal, inherent to the material, and to be expected — it is a characteristic of natural products, not a defect. Samples, displays, and on-screen images are representative only and are not guaranteed to match production material exactly. Roma does not warrant that any material will match a sample, prior lot, photograph, or expectation of uniformity, and such variation is never a basis for a claim, return, or refund.' },
        { h: '3. Pricing & Quotes', p: 'Prices, promotions, availability, coverage figures, and specifications are subject to change at Roma’s sole discretion and may be corrected at any time, including after an order is submitted, in the event of pricing or typographical error. Quotes and estimates are valid only for the period stated on them or, if none is stated, for such period as Roma determines, and are subject to material availability, current lot pricing, and final measurement. Flooring is generally sold by the square foot and accessories by the unit, with coverage rounded up to full cartons or boxes.' },
        { h: '4. Orders & Acceptance', p: 'Your submission of an order is an offer to purchase. All orders are subject to acceptance by Roma, and Roma may accept, decline, limit, modify, or cancel any order, in whole or in part, at its sole discretion — including for suspected error, material unavailability, or quantity limits. No order is binding on Roma until accepted and, where applicable, paid.' },
        { h: '5. Payment & Taxes', p: 'Payment is processed through our third-party payment providers; by paying with a card, Klarna, or another offered method you also agree to that provider’s terms. Roma may require a deposit or full payment in advance, particularly for special, custom, or freight orders, on terms determined at Roma’s discretion. Applicable California sales tax is calculated at checkout. Title to and risk of loss for all materials pass to you upon delivery or pickup.' },
        { h: '6. Inspection Before Installation', p: 'You are responsible for inspecting all materials before installation. Prior to installing, cutting, or otherwise using any product, you must verify quantity, color, shade, lot, size, quality, and overall condition, and confirm the material is acceptable and suitable for its intended use. Installation, cutting, or use of any material constitutes your final acceptance of it in its delivered condition. Do not install material you believe to be incorrect or unacceptable — contact us first.' },
        { h: '7. All Sales Final — No Returns or Exchanges', p: 'ALL SALES ARE FINAL. Materials are sold without returns, exchanges, refunds, or cancellations. Special-order, custom, cut, closeout, and clearance items are in all cases non-returnable and non-refundable. Any exception is granted solely at Roma’s discretion, in writing, and may be conditioned on the material being unopened and in resalable condition and on payment of restocking, handling, and freight charges as Roma determines.' },
        { h: '8. No Claims After Installation', p: 'NO CLAIMS AFTER INSTALLATION. Once material has been installed, cut, or used, it is deemed inspected, accepted, and satisfactory, and Roma assumes NO responsibility for color, shade, quality, size, or other variation, or for any claim of any kind relating to that material. Roma is not responsible for material that is installed after a visible or discoverable concern, nor for labor, installation, removal, replacement, or related costs. Claims, if any are permitted at all, must be raised before installation.' },
        { h: '9. Shipping, Freight & Pickup', p: 'Freight-shipped orders are quoted based on destination and scheduled after the order is placed; delivery dates are estimates and are not guaranteed. You are responsible for confirming site access and for measuring for delivery, and for inspecting shipments for visible damage or shortage at the time of delivery. Showroom pickup is available at our Anaheim location; uncollected material may be subject to storage fees at Roma’s discretion. Title and risk of loss pass to you upon delivery or pickup.' },
        { h: '10. Cancellations & Special Orders', p: 'Orders may be cancelled only with Roma’s written consent and at Roma’s discretion. Special, custom, and non-stock orders are placed on your behalf and are non-cancellable and non-refundable once submitted to the vendor. Where a cancellation is permitted, it may be subject to restocking, handling, and freight charges and to forfeiture of deposits, as determined by Roma.' },
        { h: '11. Warranties & Disclaimer', p: 'Manufactured products may carry the applicable manufacturer’s warranty, which is provided by the manufacturer and not by Roma; any warranty claim is subject to that manufacturer’s terms and process. Except for any express written warranty provided by Roma, all products and services are furnished “AS IS” and “WITH ALL FAULTS,” and Roma disclaims all other warranties, express or implied, including any implied warranty of merchantability or fitness for a particular purpose, to the fullest extent permitted by law.' },
        { h: '12. Limitation of Liability', p: 'To the maximum extent permitted by law, Roma’s total liability arising out of or relating to any product, order, or these Terms shall not exceed the amount actually paid to Roma for the specific product giving rise to the claim, and Roma shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, labor, installation, removal, replacement, or delay costs, even if advised of the possibility of such damages. Roma is not responsible for installation performed by you or by any third party.' },
        { h: '13. Trade Program', p: 'Trade accounts, trade pricing, and payment terms are offered at Roma’s discretion and are subject to eligibility verification, program terms, and any applicable membership terms in effect. Roma may modify, suspend, or terminate a trade account or its benefits at any time at its discretion.' },
        { h: '14. Governing Law', p: 'These Terms and any sale are governed by the laws of the State of California, without regard to its conflict-of-laws rules. The exclusive venue for any dispute shall be the state or federal courts located in Orange County, California, and you consent to their jurisdiction. If any provision of these Terms is found unenforceable, the remaining provisions remain in full force and effect.' },
        { h: '15. Changes to These Terms', p: 'Roma may revise these Terms at any time at its discretion by posting an updated version. The Terms in effect at the time of your order govern that order. Your continued use of this site or purchase from Roma constitutes acceptance of the then-current Terms.' },
        { h: '16. Contact', p: 'Questions about these Terms? Contact us using the details below.' },
      ];
      const privacySections = [
        { h: '1. Overview', p: 'This Privacy Policy explains how Roma Flooring Designs (“Roma,” “we,” or “us”) collects, uses, and shares information when you visit this site, create an account, request a sample or quote, place an order, or otherwise interact with us. By using this site or purchasing from us, you consent to the practices described here. This policy applies to our online storefront and related services and does not govern any third party’s site or service.' },
        { h: '2. Information You Provide', p: 'We collect information you give us directly — for example your name, email address, phone number, billing and shipping addresses, order and sample-request history, account login credentials, project details, and any messages you send us. If you apply to our trade program, we may also collect business information and verification documents such as your business name, resale certificate, EIN, and contractor license.' },
        { h: '3. Information Collected Automatically', p: 'When you use the site we automatically collect certain technical and usage information, such as your device and browser type, IP address, pages viewed, products and quotes you interact with, referring pages, and a cart or session identifier. We use cookies, local storage, and similar technologies to keep your cart and session working, remember preferences and recently viewed items, and measure how the site is used.' },
        { h: '4. Payment Information', p: 'Payments are processed by our third-party payment providers (such as Stripe and Klarna). Full payment card numbers are entered with and handled by those providers and are not stored on our servers; we may retain limited, non-sensitive details such as the card brand and last four digits, a processor customer or payment token, and transaction status to service your order, process refunds, and prevent fraud. Your use of a payment provider is also subject to that provider’s own terms and privacy policy.' },
        { h: '5. How We Use Information', p: 'We use information to process, fulfill, and deliver orders and samples; create and manage accounts; verify and administer trade accounts; provide customer support; send transactional messages such as order, account, and shipping notifications; operate, secure, and improve the site and our products and services; measure engagement and analytics; detect and prevent fraud or misuse; and comply with legal obligations. With your consent where required, or as otherwise permitted, we may also send marketing or promotional communications, which you can opt out of at any time.' },
        { h: '6. How We Share Information', p: 'We share information as needed to run the business — for example with service providers that host our systems, process payments, deliver shipments, fulfill orders through our vendors, send email, and provide analytics — each of whom is permitted to use the information only to perform services for us. We may also disclose information to comply with law, enforce our agreements, protect the rights, safety, and property of Roma or others, or in connection with a merger, acquisition, financing, or sale of assets. We do not sell your personal information.' },
        { h: '7. Cookies & Your Choices', p: 'Most browsers let you refuse or delete cookies through their settings; note that disabling cookies may affect cart, checkout, and other features. You may unsubscribe from marketing emails using the link in those messages or by contacting us; we may still send you non-promotional, transactional messages about your orders and account.' },
        { h: '8. Data Retention', p: 'We retain information for as long as needed to provide our services, maintain your account and order records, resolve disputes, and comply with our legal, tax, and accounting obligations, and otherwise as determined by Roma. When information is no longer needed, we take reasonable steps to delete or de-identify it.' },
        { h: '9. Data Security', p: 'We use reasonable, industry-standard safeguards — including encryption in transit — designed to protect information under our control. No method of transmission or storage is completely secure, however, and we cannot guarantee absolute security. You are responsible for keeping your account credentials confidential.' },
        { h: '10. Your Rights', p: 'You may access or update your account information by signing in, or request access, correction, or deletion of your personal information by contacting us. Depending on where you live, you may have additional rights under applicable law. California residents may, subject to the California Consumer Privacy Act as amended, request to know the personal information we have collected, request its deletion or correction, and opt out of any “sale” or “sharing” of personal information — noting that we do not sell personal information — and will not be discriminated against for exercising these rights. We may need to verify your identity before acting on a request.' },
        { h: '11. Children’s Privacy', p: 'This site is intended for adults and is not directed to children. We do not knowingly collect personal information from children under 16. If you believe a child has provided us information, please contact us and we will take appropriate steps to delete it.' },
        { h: '12. Third-Party Links', p: 'Our site may link to third-party websites or services that we do not control. We are not responsible for the privacy practices or content of those third parties, and we encourage you to review their policies.' },
        { h: '13. Changes to This Policy', p: 'We may update this Privacy Policy from time to time at our discretion. Changes are effective when the updated policy is posted, and your continued use of the site or purchase from Roma constitutes acceptance of the then-current policy.' },
        { h: '14. Contact', p: 'Questions about your privacy or this policy? Contact us using the details below.' },
      ];
      const sections = isTerms ? termsSections : privacySections;
      return (
        <div style={{ maxWidth: 760, margin: '3.5rem auto 5rem', padding: '0 2rem' }}>
          <div style={{ fontSize: '0.6875rem', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--stone-500)', marginBottom: '0.75rem' }}>
            Roma Flooring Designs
          </div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 300, fontSize: '2.75rem', lineHeight: 1.1, margin: '0 0 0.5rem' }}>{title}</h1>
          <div style={{ color: 'var(--stone-500)', fontSize: '0.875rem', marginBottom: '2rem' }}>Effective date: to be finalized</div>
          {sections.map((s, i) => (
            <section key={i} style={{ marginBottom: '1.75rem' }}>
              <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: '1.0625rem', margin: '0 0 0.5rem', color: 'var(--stone-800)' }}>{s.h}</h2>
              <p style={{ color: 'var(--stone-600)', fontSize: '0.9375rem', lineHeight: 1.65, margin: 0 }}>{s.p}</p>
            </section>
          ))}
          <div style={{ marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '0.5px solid rgba(28,25,23,0.13)', color: 'var(--stone-600)', fontSize: '0.875rem', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 600, color: 'var(--stone-800)' }}>Roma Flooring Designs</div>
            <div>1440 South State College Blvd #6M, Anaheim, CA 92806</div>
            <div>License #830966 &middot; (714) 999-0009</div>
          </div>
          <div style={{ marginTop: '2rem', display: 'flex', gap: '1.25rem', fontSize: '0.875rem' }}>
            <a href={isTerms ? '/privacy' : '/terms'} onClick={e => { e.preventDefault(); navigate(isTerms ? '/privacy' : '/terms'); }} style={{ color: 'var(--stone-700)', textDecoration: 'underline' }}>
              {isTerms ? 'Privacy Policy' : 'Terms of Service'}
            </a>
            <a href="/" onClick={e => { e.preventDefault(); goHome(); }} style={{ color: 'var(--stone-700)', textDecoration: 'underline' }}>Back to home</a>
          </div>
        </div>
      );
    }

    // ==================== Footer (Redesigned) ====================

    function SiteFooter({ goHome, goBrowse, goCollections, goTrade, onInstallClick, navigate }) {
      return (
        <div className="footer">
          <div className="footer-inner">
            <div className="footer-brand">
              <h3>Roma Flooring Designs</h3>
              <p>Premium flooring, tile, stone, and countertop products. Curated collections for designers, builders, and homeowners since 2010.</p>
            </div>
            <div className="footer-col">
              <h4>Shop</h4>
              <a href="#" onClick={e => { e.preventDefault(); goBrowse(); }}>All Products</a>
              <a href="#" onClick={e => { e.preventDefault(); goCollections(); }}>Collections</a>
              <a href="#" onClick={e => { e.preventDefault(); navigate('/shop?new=1'); }}>New Arrivals</a>
              <a href="#" onClick={e => { e.preventDefault(); navigate('/shop?sale=1'); }}>Sale</a>
            </div>
            <div className="footer-col">
              <h4>Services</h4>
              <a href="#" onClick={e => { e.preventDefault(); onInstallClick && onInstallClick(); }}>Installation</a>
              <a href="#" onClick={e => { e.preventDefault(); navigate('/shop'); }}>Design Consultation</a>
              <a href="#" onClick={e => { e.preventDefault(); navigate('/shop'); }}>Room Visualizer</a>
              <a href="#" onClick={e => { e.preventDefault(); navigate('/shop'); }}>Free Samples</a>
            </div>
            <div className="footer-col">
              <h4>Trade</h4>
              <a href="#" onClick={e => { e.preventDefault(); goTrade(); }}>Trade Program</a>
              <a href="#" onClick={e => { e.preventDefault(); goTrade(); }}>Apply Now</a>
              <a href="#" onClick={e => { e.preventDefault(); goTrade(); }}>Trade Login</a>
            </div>
            <div className="footer-col">
              <h4>Visit</h4>
              <div className="footer-visit-detail">
                1440 S. State College Blvd Suite 6M<br />Anaheim, CA 92806<br /><br />
                Mon–Fri 9am–5pm<br />Sat 10am–5pm<br />Sun Closed<br /><br />
                <a href="tel:+17149990009">(714) 999-0009</a><br />
                <a href="mailto:Sales@romaflooringdesigns.com">Sales@romaflooringdesigns.com</a>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            &copy; 2026 Roma Flooring Designs. All rights reserved. License #830966
            <div className="footer-bottom-links">
              <a href="/privacy" onClick={e => { e.preventDefault(); navigate('/privacy'); }}>Privacy</a>
              <span>|</span>
              <a href="/terms" onClick={e => { e.preventDefault(); navigate('/terms'); }}>Terms</a>
              <span>|</span>
              <a href="#" onClick={e => e.preventDefault()}>Accessibility</a>
            </div>
          </div>
        </div>
      );
    }

    // ==================== Render ====================

    ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><StorefrontApp /></ErrorBoundary>);
