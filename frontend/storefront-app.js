(() => {
  const { useState, useEffect, useRef, useCallback, useMemo } = React;
  const API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:3001" : `${window.location.protocol}//${window.location.hostname}:3001`;
  function getSessionId() {
    let id = localStorage.getItem("cart_session_id");
    if (!id) {
      id = "sess_" + crypto.randomUUID();
      try {
        localStorage.setItem("cart_session_id", id);
      } catch (e) {
      }
    }
    return id;
  }
  function generateSlug(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }
  const SITE_URL = "https://www.romaflooringdesigns.com";
  function updateSEO({ title, description, url, image }) {
    document.title = title || "Shop | Roma Flooring Designs";
    const setMeta = (selector, value) => {
      const el = document.querySelector(selector);
      if (el) el.setAttribute("content", value || "");
    };
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[property="og:url"]', url);
    setMeta('meta[property="og:image"]', image || "");
    setMeta('meta[name="twitter:title"]', title);
    setMeta('meta[name="twitter:description"]', description);
    setMeta('meta[name="twitter:image"]', image || "");
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical && url) canonical.setAttribute("href", url);
  }
  function setDynamicJsonLd(data) {
    let el = document.getElementById("dynamic-jsonld");
    if (!el) {
      el = document.createElement("script");
      el.type = "application/ld+json";
      el.id = "dynamic-jsonld";
      document.head.appendChild(el);
    }
    el.textContent = JSON.stringify(data);
  }
  function isSoldPerUnit(sku) {
    if (!sku) return false;
    if (sku.sell_by) return sku.sell_by === "unit";
    return sku.price_basis === "per_unit";
  }
  function isSoldPerSqyd(sku) {
    if (!sku) return false;
    if (sku.sell_by) return sku.sell_by === "roll";
    return sku.price_basis === "per_sqyd";
  }
  function isCarpet(sku) {
    return sku && sku.cut_price != null && sku.sell_by === "roll";
  }
  function parseRollWidthFt(productName) {
    if (!productName) return 0;
    const m = productName.match(/(?:^|\D)(12|6(?:\.\d{1,2})?)(?:\D|$)/);
    return m ? parseFloat(m[1]) : 0;
  }
  function carpetSqftPrice(sqydPrice) {
    return (parseFloat(sqydPrice) / 9).toFixed(2);
  }
  function parseFractionalInches(str) {
    if (!str || typeof str !== "string") return NaN;
    const s = str.replace(/["″\s]/g, "").trim();
    const wf = s.match(/^(\d+)[-\s](\d+)\/(\d+)$/);
    if (wf) return parseInt(wf[1]) + parseInt(wf[2]) / parseInt(wf[3]);
    const f = s.match(/^(\d+)\/(\d+)$/);
    if (f) return parseInt(f[1]) / parseInt(f[2]);
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }
  function normalizeSize(val) {
    if (!val || typeof val !== "string") return "";
    return val.replace(/\s*[xX×]\s*/g, "x").replace(/\s+/g, " ").replace(/\.00/g, "").trim();
  }
  function getVariantImage(sibling, options = {}) {
    if (!sibling) return null;
    if (options.preferCountertop && sibling.countertop_image) return sibling.countertop_image;
    if (options.preferSku && sibling.sku_image) return sibling.sku_image;
    return sibling.primary_image || sibling.sku_image || sibling.shape_image || null;
  }
  function formatSizeDim(val) {
    if (!val || typeof val !== "string") return val;
    if (/^PATTERN$/i.test(val)) return "Pattern";
    const isFeet = /FT$/i.test(val);
    const isEZ = /EZ$/i.test(val);
    const cleaned = val.replace(/\s*(EZ|FT)\s*$/gi, "").trim();
    const m = cleaned.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)(.*)$/);
    if (!m) return formatCarpetValue(val);
    let d1 = m[1].replace(/\.00$/, ""), d2 = m[2].replace(/\.00$/, "");
    const suffix = (m[3] || "").trim();
    const unit = isFeet ? "\u2032" : "\u2033";
    return d1 + unit + " \xD7 " + d2 + unit + (suffix ? " " + suffix : "") + (isEZ ? " Mosaic" : "");
  }
  function formatCarpetValue(val) {
    if (!val || typeof val !== "string") return val;
    const fiberMatch = val.match(/^(?:PILE\s+)?(\d+)\s+(.+)$/i);
    if (fiberMatch && /^[A-Z0-9\s]+$/.test(val) && /NYLON|POLYESTER|PET|OLEFIN|WOOL|TRIEXTA|POLYPROPYLENE/i.test(val)) {
      const fiber = fiberMatch[2].trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bPet\b/g, "PET Polyester").replace(/\bBcf\b/g, "BCF");
      return fiberMatch[1] + "% " + fiber;
    }
    if (val === val.toUpperCase() && val.length > 2) {
      return val.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(That|It|Don|Can|Won|Isn|Ain|Couldn|Wouldn|Shouldn|Didn|Wasn|Weren|Hasn|Haven|Let|What|Who|Where|There|Here) (S|T|Re|Ve|Ll|D|M)\b/g, (m, w, c) => w + "'" + c.toLowerCase()).replace(/\bBcf\b/g, "BCF").replace(/\bPet\b/g, "PET").replace(/\bSd\b/g, "SD").replace(/\bP\.e\.t\b/gi, "PET").replace(/\bIii\b/g, "III").replace(/\bIi\b/g, "II").replace(/\bIv\b/g, "IV").replace(/\bViii\b/g, "VIII").replace(/\bVii\b/g, "VII").replace(/\bVi\b/g, "VI");
    }
    return val;
  }
  function priceSuffix(sku) {
    if (isSoldPerUnit(sku)) {
      if (sku && (sku.price_basis === "sqft" || sku.price_basis === "per_sqft") && !(parseFloat(sku.sqft_per_box) > 0)) {
        return "/sqft";
      }
      return "/ea";
    }
    if (isSoldPerSqyd(sku)) return "/sqyd";
    return "/sqft";
  }
  function skuListPrice(sku) {
    if (!sku) return 0;
    return isCarpet(sku) ? sku.cut_price : sku.retail_price;
  }
  function displayPrice(sku, rawPrice) {
    const price = parseFloat(rawPrice || 0);
    if (sku && sku.sell_by === "unit" && (sku.price_basis === "sqft" || sku.price_basis === "per_sqft") && parseFloat(sku.sqft_per_box) > 0) {
      return price * parseFloat(sku.sqft_per_box);
    }
    return price;
  }
  function handleProductImgLoad(e) {
    const { naturalWidth: w, naturalHeight: h } = e.target;
    if (!w || !h) return;
    const src = e.target.currentSrc || e.target.src || "";
    if (w === 300 && h === 300 && src.includes(".widen.net")) {
      const attempt = parseInt(e.target.dataset.widenRetry || "0", 10);
      if (attempt >= 2) {
        e.target.style.display = "none";
        return;
      }
      e.target.dataset.widenRetry = String(attempt + 1);
      if (e.target.srcset) e.target.srcset = "";
      if (attempt === 0) {
        const clean = src.replace(/[&?]_cb=\d+/, "");
        const sep = clean.includes("?") ? "&" : "?";
        e.target.src = clean + sep + "_cb=" + Date.now();
      } else {
        const u = new URL(src);
        u.search = "";
        e.target.src = u.toString();
      }
      return;
    }
    const r = w / h;
    if (r > 1.4 || r < 0.71) {
      e.target.style.objectFit = "contain";
      const card = e.target.closest(".sku-card");
      if (card) card.classList.add("sku-card--contain");
    }
  }
  function optimizeImg(url, width) {
    if (!url || typeof url !== "string") return url;
    try {
      if (url.includes("i8.amplience.net")) {
        const u = new URL(url);
        u.searchParams.set("w", width);
        u.searchParams.set("fmt", "auto");
        u.searchParams.set("qlt", "80");
        return u.toString();
      }
      if (url.includes("res.cloudinary.com") && url.includes("/upload/")) {
        return url.replace(/\/upload\/(?:[a-z]_[^/]+\/)*/, `/upload/w_${width},f_auto,q_80/`);
      }
      if (url.includes("images.salsify.com") && url.includes("/upload/")) {
        return url.replace(/\/upload\/(s--[A-Za-z0-9_-]+--\/)/, `/upload/$1w_${width},f_auto,q_80/`);
      }
      if (url.includes("static.wixstatic.com/media/")) {
        const base = url.split("?")[0];
        return `${base}/v1/fill/w_${width},h_${width},al_c,q_80/image.jpg`;
      }
      if (url.includes(".widen.net")) {
        const u = new URL(url);
        u.searchParams.delete("w");
        u.searchParams.delete("h");
        u.searchParams.delete("quality");
        u.searchParams.delete("position");
        u.searchParams.delete("keep");
        u.searchParams.delete("x.app");
        return `/api/img?url=${encodeURIComponent(u.toString())}&w=${width}`;
      }
      const PROXY_DOMAINS = [
        "cdn.msisurfaces.com",
        "elysiumtile.com",
        "melangetile.com",
        "ragnousa.com",
        "onetile.us",
        "energieker.it",
        "emilgroup.it",
        "platformsurfaces.com",
        "lafabbrica.it",
        "cercomceramiche.it",
        "supergres.com",
        "onetile.it",
        "landoftile.com",
        "milestonetiles.com",
        "midwesttile.com",
        "domita.it",
        "refin-ceramic-tiles.com",
        "tilelook.com",
        "somertile.com",
        "equipeceramicas.com",
        "edilportale.com",
        "cegoceramiche.com",
        "manningtonprod.pimcoreclient.com",
        "www.hartco.com",
        "armstrongflooring.com",
        "style-access.com"
      ];
      if (url.startsWith("/uploads/rom440/") || PROXY_DOMAINS.some((d) => url.includes(d))) {
        return `/api/img?url=${encodeURIComponent(url)}&w=${width}`;
      }
    } catch (e) {
    }
    return url;
  }
  function optimizeSrcSet(url, sizes) {
    if (!url || typeof url !== "string") return {};
    const srcSet = sizes.map((w) => `${optimizeImg(url, w)} ${w}w`).join(", ");
    return { srcSet };
  }
  const RECENT_SEARCHES_KEY = "roma_recent_searches";
  const MAX_RECENT_SEARCHES = 6;
  function getRecentSearches() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }
  function addRecentSearch(term) {
    if (!term || term.length < 2) return;
    const recent = getRecentSearches().filter((t) => t.toLowerCase() !== term.toLowerCase());
    recent.unshift(term);
    try {
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES)));
    } catch (e) {
    }
  }
  function clearRecentSearches() {
    localStorage.removeItem(RECENT_SEARCHES_KEY);
  }
  function highlightMatch(text, query) {
    if (!query || query.length < 2 || !text) return text;
    try {
      const regex = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
      const parts = String(text).split(regex);
      if (parts.length === 1) return text;
      return parts.map((part, i) => i % 2 === 1 ? React.createElement("mark", { key: i, className: "search-highlight" }, part) : part);
    } catch (e) {
      return text;
    }
  }
  const STYLE_COLOR_MAP = {
    // --- Blonde (light warm wood tones) ---
    "Akadia": "Blonde",
    "Austell Grove": "Blonde",
    "Ayla": "Blonde",
    "Bellamy Brooks": "Blonde",
    "Bozeman": "Blonde",
    "Bramlett": "Blonde",
    "Brookings": "Blonde",
    "Brookline": "Blonde",
    "Cabana": "Blonde",
    "Chester Hills": "Blonde",
    "Coastal Cottage": "Blonde",
    "Driftway": "Blonde",
    "Elwood": "Blonde",
    "Fallonton": "Blonde",
    "Hatboro Hills": "Blonde",
    "Houston Trail": "Blonde",
    "Hyde Haven": "Blonde",
    "Lark": "Blonde",
    "Larkin": "Blonde",
    "Lazura": "Blonde",
    "Lenexa Creek": "Blonde",
    "Mable": "Blonde",
    "Malta": "Blonde",
    "Meadow": "Blonde",
    "Mellshire": "Blonde",
    "Moorville": "Blonde",
    "Northcutt": "Blonde",
    "Palmilla": "Blonde",
    "Quillian": "Blonde",
    "Roswell": "Blonde",
    "Runmill Isle": "Blonde",
    "Shasta Grove": "Blonde",
    "Sundelle": "Blonde",
    "Tifton": "Blonde",
    "Tranquilla": "Blonde",
    "Valleyview Grove": "Blonde",
    "Ventar": "Blonde",
    "Vintaj": "Blonde",
    "Waldorf": "Blonde",
    "Wharton": "Blonde",
    "Whitlock": "Blonde",
    "Wilton": "Blonde",
    // Blonde overrides (keyword would give wrong family)
    "Highcliffe Greige": "Blonde",
    "Sandino": "Blonde",
    "Linen Loggia": "Blonde",
    "Bayside Buff": "Blonde",
    "Honey Bella Oak": "Blonde",
    "Ivorelle": "Blonde",
    "Sunny Shake": "Blonde",
    "Sunnyvale": "Blonde",
    // --- Beige (warm neutral tones) ---
    "Baylin": "Beige",
    "Bayside Grove": "Beige",
    "Cranton": "Beige",
    "Doack": "Beige",
    "Draven": "Beige",
    "Woburn Abbey": "Beige",
    "Bleached Elm": "Beige",
    // Beige overrides
    "Dunite Oak": "Beige",
    "Lime Washed Oak": "Beige",
    // --- Brown (medium to dark wood tones) ---
    "Abingdale": "Brown",
    "Adlar": "Brown",
    "Andaz": "Brown",
    "Ardmore Valley": "Brown",
    "Atwood": "Brown",
    "Barnstorm": "Brown",
    "Barrell": "Brown",
    "Beckley Bruno": "Brown",
    "Bembridge": "Brown",
    "Bergen Hills": "Brown",
    "Billingham": "Brown",
    "Bluffview": "Brown",
    "Blythe": "Brown",
    "Braly": "Brown",
    "Briar Haven": "Brown",
    "Brockton": "Brown",
    "Brundinson": "Brown",
    "Chelsea Heights": "Brown",
    "Colston Park": "Brown",
    "Delray": "Brown",
    "Dunmere": "Brown",
    "Dunova": "Brown",
    "Exotika": "Brown",
    "Fauna": "Brown",
    "Hatfield": "Brown",
    "Hawthorne": "Brown",
    "Hillsdale": "Brown",
    "Hinton": "Brown",
    "Jenta": "Brown",
    "Louise Hill": "Brown",
    "Macland": "Brown",
    "Malden": "Brown",
    "Mesa Ridge": "Brown",
    "Millhaven": "Brown",
    "Quercia": "Brown",
    "Roghan": "Brown",
    "Ryder": "Brown",
    "Saddle Wood": "Brown",
    "Scandi": "Brown",
    "Selbourne": "Brown",
    "Sequoia": "Brown",
    "Stable": "Brown",
    "Sunnyset": "Brown",
    "Swilcan": "Brown",
    "Taos": "Brown",
    "Thornburg": "Brown",
    "Vexton": "Brown",
    "Waldron": "Brown",
    "Wayland": "Brown",
    "Weathered Brina": "Brown",
    "Wixom Valley": "Brown",
    "Wolfeboro": "Brown",
    "Timbra": "Brown",
    "Sable": "Brown",
    // Brown overrides
    "Amber Forrester": "Brown",
    "Charcoal Oak": "Brown",
    // --- Gray (cool tones) ---
    "Baystone": "Gray",
    "Boswell": "Gray",
    "Bourland": "Gray",
    "Bracken Hill": "Gray",
    "Brianka": "Gray",
    "Coastal Mix": "Gray",
    "Dakworth": "Gray",
    "Dulcet Taiga": "Gray",
    "Emridge": "Gray",
    "Finely": "Gray",
    "Kardigan": "Gray",
    "Liora": "Gray",
    "Loton Hill": "Gray",
    "Ludlow": "Gray",
    "Malton": "Gray",
    "Mezcla": "Gray",
    "Milledge": "Gray",
    "Stableton": "Gray",
    "Stormbound": "Gray",
    "Whitmore": "Gray",
    // Gray overrides
    "Midnight Maple": "Gray",
    // --- White (light, marble-look, stone-look) ---
    "Calacatta Legend": "White",
    "Calacatta Marbello": "White",
    "Calacatta Serra": "White",
    "Carrara Avell": "White",
    "Harbor Marble": "White",
    "Quarzo Taj": "White",
    // White overrides
    "Calacatta Venosa Gold": "White",
    // --- Multi ---
    "Kentazza": "Multi",
    "Windsor Crest": "Multi",
    "Windsor Isle": "Multi",
    // --- Tile-specific style names ---
    "Ice": "White",
    "Pure": "White",
    "Glacier": "White",
    "Statuario": "White",
    "Thassos": "White",
    "Dark": "Gray",
    "Silicon": "Gray",
    "Luna": "Gray",
    "Iron": "Gray",
    "Shadow": "Gray",
    "Stone": "Gray",
    "Terra": "Brown",
    "Terra Nova": "Brown",
    "Earth": "Brown",
    "Sky": "Blue",
    "Marina": "Blue",
    "Herringbone": null,
    "Wall": null,
    "Gloss": null,
    "Gloss Wall": null,
    "Structured": null,
    "Decorative": null,
    "Black & White": "Multi",
    // ADEX tile colors
    "Volcanico": "Gray",
    "Monzon": "Gray",
    "Sirocco": "Beige",
    "Poniente": "Beige",
    "Terral": "Beige",
    "Brisa": "White",
    "Solano": "Beige",
    "Aire": "White",
    "Top Sail": "White",
    "Glossy Cloud": "Gray",
    "Glossy Leaf": "Green",
    // Daltile & multi-vendor tile names
    "Maestro": "Gray",
    "Bravura": "Beige",
    "Composer": "Gray",
    "Emissary": "Gray",
    "Magistrate": "Gray",
    "Proxy": "Gray",
    "Poise": "Beige",
    "Summit": "Gray",
    "Basin": "Gray",
    "Wisdom": "Beige",
    "Serenity": "White",
    "Horizon": "Gray",
    "Dama": "Gray",
    "Lugo": "Gray",
    "Astorga": "Beige",
    "Fermi": "Gray",
    "Agnesi": "Gray",
    "Titanium": "Gray",
    "Pismo": "Gray",
    "Trail": "Brown",
    // --- Extended tile color names ---
    // Daltile Keystones / Color Wheel / Rittenhouse product names
    "Chalkboard": "Gray",
    "Dependable": "Beige",
    "Calm": "Beige",
    "Balance": "Gray",
    "Restore": "Beige",
    "Spa": "Blue",
    "Medallion": "Beige",
    "Plum Crazy": "Red",
    "Orange Burst": "Gold",
    "Royal Purple": "Red",
    "Midnight": "Black",
    "Galaxy": "Black",
    "Light": "White",
    "Sunburst": "Gold",
    "Parrot": "Green",
    "Waterfall": "Blue",
    "Fresh": "White",
    "Passion": "Red",
    "Clair": "White",
    "Cove Breeze": "Blue",
    "Cruz": "Brown",
    "Grace": "White",
    "Legacy": "Beige",
    "Mill": "Gray",
    "Pascal": "Gray",
    "Royal": "Blue",
    "Salt & Pepper": "Gray",
    "Malibu": "Blue",
    "Reflexion Bright": "White",
    "Glow": "Gold",
    "Nantes": "Beige",
    "Currant": "Red",
    "Lake": "Blue",
    "Sea Breeze": "Blue",
    "Tundra": "Gray",
    "Eclipse": "Black",
    "Dust": "Beige",
    "Touch Glow": "Gold",
    "Tarmac": "Gray",
    "Toffee": "Brown",
    "Alba": "White",
    "Illusive": "Gray",
    "Arena": "Beige",
    "Pacifica": "Blue",
    "Bella": "Beige",
    "Desert": "Beige",
    "Artic": "White",
    "Urban Putty": "Beige",
    // Arizona Tile product names
    "Fluida Aurea": "Gold",
    "Aequa Castor": "Brown",
    "Tru Marmi Arabescato": "White",
    "Reverie 1": "Beige",
    // Misc tile vendor-specific names
    "Volakas": "White",
    "Skyline": "Gray",
    "Cyber": "Gray",
    "Petrolio": "Blue",
    "Siena": "Brown",
    "Alpi Avana": "Brown",
    "Yang": "White",
    "Yin": "Black",
    // More tile product names (sorted by SKU count)
    "Taj Mahal": "Gold",
    "Twilight": "Gray",
    "Dusk": "Gray",
    "Soil": "Brown",
    "Asphalt": "Gray",
    "Verrazzo Argilla": "Beige",
    "Talco": "White",
    "Cristallo": "White",
    "Key Lime": "Green",
    "Shore": "Beige",
    "Magnolia": "White",
    "Riverbed": "Gray",
    "Moon": "Gray",
    "Classic": "Beige",
    "Clear": "White",
    "Azul": "Blue",
    "Stucco": "Beige",
    "Argent": "Gray",
    "Current": "Blue",
    "Dawn": "Beige",
    "Diamond Mine": "Gray",
    "Ink": "Black",
    "Mystic": "Gray",
    "Leaf": "Green",
    "Autumn": "Gold",
    "Biscotti": "Beige",
    "Bleu": "Blue",
    "Cliff": "Gray",
    "Ginger": "Brown",
    "Haze": "Gray",
    "Orange": "Gold",
    "Rock": "Gray",
    "Scuro": "Gray",
    "Pink": "Red",
    "Giallo": "Gold",
    "Calacata": "White",
    "Bronzo": "Gold",
    "Nimbus": "Gray",
    "Buckskin": "Brown",
    "Lotus": "White",
    "Oxide": "Brown",
    "Silt": "Beige",
    "Shell": "Beige",
    "Spring": "Green",
    "Cove": "Blue",
    "Composure": "Gray",
    "Allure": "Beige",
    "Aura": "White",
    "Skyrocket": "Blue",
    "Loft": "Gray",
    "Shine": "White",
    "Panda": "White",
    "Plume": "White",
    // Non-color tile entries (finishes, formats, parts)
    "Shower Pan W Drain": null,
    "N A": null,
    'Highlights 12x12 Db 1/8"': null,
    "Polished 24x48": null,
    "Straight Joint": null,
    "Up": null,
    "Select": null,
    "Uplifted": null
  };
  const NON_COLOR_VALUES = /* @__PURE__ */ new Set([
    "wall",
    "gloss wall",
    "gloss",
    "structured",
    "decorative",
    "herringbone",
    "pro matt",
    '" pro matt',
    "large",
    "small",
    'large ( ")',
    'small ( ")',
    "n a",
    "shower pan w drain",
    "straight joint",
    "gauged",
    "polished",
    "tumbled",
    "undulated",
    "crackled",
    "leathered",
    "grip r11",
    "matte",
    "gloss herringbone",
    "image overlay",
    "select",
    "up",
    "uplifted"
  ]);
  const COLOR_FAMILIES = {
    "White": { hex: "#f5f5f0", keywords: ["white", "ivory", "cream", "snow", "pearl", "alabaster", "frost", "arctic", "bright white", "blanc", "bianco", "bianca", "blanco", "calacatta", "carrara", "chalk", "dolomite", "thassos", "perla", "perle", "opal"] },
    "Gray": { hex: "#9e9e9e", keywords: ["gray", "grey", "charcoal", "silver", "slate", "ash", "smoke", "graphite", "pewter", "cement", "concrete", "fog", "grigio", "gris", "cenere", "steel", "platinum", "basalt", "mist", "dove", "bardiglio", "greige", "lead", "cloud", "anthracite", "antracita", "argento", "nickel", "pebble", "marengo", "flint", "shale"] },
    "Beige": { hex: "#d4c5a9", keywords: ["beige", "tan", "sand", "taupe", "khaki", "linen", "wheat", "bone", "champagne", "natural", "almond", "buff", "crema", "avorio", "fawn", "biscuit", "dune", "ecru", "oyster", "vanilla", "nude", "bamboo", "lino", "marfil", "sabbia", "creme", "clay", "putty", "latte", "fossil", "travertine", "parchment"] },
    "Brown": { hex: "#8b6f47", keywords: ["brown", "chocolate", "coffee", "mocha", "walnut", "chestnut", "mahogany", "espresso", "umber", "oak", "hickory", "pecan", "caramel", "acacia", "birch", "timber", "tawny", "saddle", "jatoba", "noce", "cotto", "nutmeg", "henna", "cafe", "carob", "cappuccino", "cinnamon"] },
    "Black": { hex: "#2c2c2c", keywords: ["black", "onyx", "ebony", "jet", "noir", "obsidian", "nero", "carbon", "coal", "grafito", "negro", "marquina"] },
    "Blue": { hex: "#6b8cae", keywords: ["blue", "navy", "cobalt", "teal", "aqua", "sapphire", "ocean", "azure", "cerulean", "indigo", "denim", "cielo", "lagoon", "bleu"] },
    "Green": { hex: "#7a9972", keywords: ["green", "sage", "olive", "forest", "emerald", "moss", "mint", "jade", "celadon", "verde", "fern", "eucalyptus", "salvia", "willow"] },
    "Red": { hex: "#b54c4c", keywords: ["red", "burgundy", "wine", "cherry", "crimson", "maroon", "rust", "brick", "terracotta", "rose", "blush", "currant", "peach"] },
    "Gold": { hex: "#c9a668", keywords: ["gold", "golden", "honey", "amber", "copper", "bronze", "brass", "oro", "mustard", "cornsilk", "yellow", "aurea", "giallo", "bronzo"] },
    "Blonde": { hex: "#dcc9a3", keywords: ["blonde", "blond", "flaxen", "straw", "light oak", "light natural"] },
    "Multi": { hex: "conic-gradient(#f5f5f0,#9e9e9e,#d4c5a9,#8b6f47,#6b8cae)", keywords: ["multi", "mixed", "multicolor", "variegated", "blend"] }
  };
  function mapColorToFamily(rawColor) {
    if (!rawColor) return null;
    const lower = rawColor.toLowerCase().trim();
    if (!lower || lower === "xxx" || lower === "n/a" || lower === "na" || lower === "n a" || lower === "misc." || lower === "misc") return null;
    if (NON_COLOR_VALUES.has(lower)) return null;
    if (/^(?:polished|honed|matte|tumbled|gauged)\s+\d/i.test(lower)) return null;
    const trimmed = rawColor.trim();
    if (trimmed in STYLE_COLOR_MAP) return STYLE_COLOR_MAP[trimmed];
    const base = trimmed.replace(/^(?:Matte|Glossy|Stria|Satin)\s+/i, "").replace(/\s+Spc\s+Matte$/i, "").replace(/\s+SuperGuardX\s+Technology$/i, "").replace(/\s+(?:Matte|Speckle|Speckled|Spc|USA|Linen)$/i, "").trim();
    if (base !== trimmed && base in STYLE_COLOR_MAP) return STYLE_COLOR_MAP[base];
    for (const [family, { keywords }] of Object.entries(COLOR_FAMILIES)) {
      if (keywords.some((kw) => lower.includes(kw))) return family;
    }
    return null;
  }
  function formatVariantName(name) {
    if (!name) return "";
    if (/[A-Z]/.test(name) && name.includes(" ")) return name;
    const parts = name.replace(/(\d)\/(\d)/g, "$1\u2044$2").split(/\s*\/\s*/);
    return parts.map((part) => {
      let formatted = part.replace(/(\d)\u2044(\d)/g, "$1/$2");
      formatted = formatted.replace(/-/g, " ");
      formatted = formatted.replace(/(\d+)\s(\d+)\s(\d+)/g, "$1-$2/$3");
      formatted = formatted.replace(/\bX\b/g, "x");
      formatted = formatted.replace(/\b\w/g, (c) => c.toUpperCase());
      formatted = formatted.replace(/(\d)\s*X\s*(\d)/g, "$1 x $2");
      return formatted.trim();
    }).join(" \u2014 ");
  }
  const ROMAN_VAL = { "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10 };
  const ROMAN_REGEX = /\b(I{1,3}|IV|V(?:I{1,3})?|IX|X)\b(?=\s+\d|\s*$)/;
  function hasRomanSuffix(name) {
    if (!name) return false;
    const m = name.match(ROMAN_REGEX);
    return !!(m && ROMAN_VAL[m[1]]);
  }
  function romanSortKey(name) {
    if (!name) return 0;
    const m = name.match(ROMAN_REGEX);
    return m && ROMAN_VAL[m[1]] || 0;
  }
  function romanPillLabel(name) {
    if (!name) return name;
    const m = name.match(ROMAN_REGEX);
    if (!m) return name;
    return name.substring(m.index).trim();
  }
  const _CATEGORY_SUFFIX_MAP = {
    "engineered hardwood": "Engineered Hardwood",
    "solid hardwood": "Solid Hardwood",
    "hardwood": "Hardwood",
    "waterproof wood": "Waterproof Wood",
    "porcelain tile": "Porcelain Tile",
    "ceramic tile": "Ceramic Tile",
    "mosaic tile": "Mosaic Tile",
    "natural stone": "Natural Stone Tile",
    "backsplash tile": "Backsplash Tile",
    "backsplash & wall tile": "Wall Tile",
    "decorative tile": "Decorative Tile",
    "pool tile": "Pool Tile",
    "wood look tile": "Wood Look Tile",
    "large format tile": "Large Format Tile",
    "fluted tile": "Fluted Tile",
    "commercial tile": "Commercial Tile",
    "porcelain slabs": "Porcelain Slab",
    "quartz countertops": "Quartz Countertop",
    "quartz": "Quartz Countertop",
    "granite countertops": "Granite Countertop",
    "quartzite countertops": "Quartzite Countertop",
    "marble countertops": "Marble Countertop",
    "soapstone countertops": "Soapstone Countertop",
    "prefabricated countertops": "Prefabricated Countertop",
    "countertops": "Countertop",
    "lvp (plank)": "Luxury Vinyl Plank",
    "lvp": "Luxury Vinyl Plank",
    "lvt (tile)": "Luxury Vinyl Tile",
    "lvt": "Luxury Vinyl Tile",
    "luxury vinyl": "Luxury Vinyl",
    "spc": "SPC Vinyl",
    "wpc": "WPC Vinyl",
    "laminate": "Laminate",
    "laminate flooring": "Laminate",
    "carpet": "Carpet",
    "carpet tile": "Carpet Tile",
    "rubber flooring": "Rubber Flooring",
    "artificial turf": "Artificial Turf",
    "vanity": "Vanity",
    "vanity tops": "Vanity Top",
    "vanities": "Vanity",
    "faucets": "Faucet",
    "bathroom faucets": "Faucet",
    "kitchen faucets": "Faucet",
    "mirrors": "Mirror",
    "sinks": "Sink",
    "kitchen sinks": "Sink",
    "bathroom sinks": "Sink",
    "shower systems": "Shower System",
    "transitions & moldings": "Molding",
    "transitions": "Molding",
    "moldings": "Molding",
    "moulding": "Molding",
    "wall base": "Wall Base",
    "underlayment": "Underlayment",
    "stair treads & nosing": "Stair Tread",
    "hardscaping": "Paver",
    "pavers": "Paver",
    "stacked stone": "Stacked Stone",
    "sheet vinyl": "Sheet Vinyl",
    "vct": "VCT",
    "vbt": "VBT"
  };
  function appendTypeSuffix(text, categoryName) {
    if (!categoryName) return text;
    const suffix = _CATEGORY_SUFFIX_MAP[categoryName.toLowerCase().trim()];
    if (!suffix) return text;
    const lower = text.toLowerCase();
    const words = suffix.toLowerCase().split(/\s+/);
    if (lower.includes(suffix.toLowerCase())) return text;
    if (words.length > 1 && words.every((w) => lower.includes(w))) return text;
    if (words.length > 0 && new RegExp("\\b" + words[0] + "\\b", "i").test(text)) return text;
    return text + " " + suffix;
  }
  function stripTypeSuffix(text, categoryName) {
    if (!categoryName) return text;
    const suffix = _CATEGORY_SUFFIX_MAP[categoryName.toLowerCase().trim()];
    if (!suffix) return text;
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\s+" + escaped + "\\s*$", "i");
    return text.replace(re, "").trim();
  }
  function cleanProductTitle(name, sku) {
    if (!name) return name;
    let cleaned = name;
    const cat = (sku.category_name || "").toLowerCase();
    const isCountertop = cat.includes("countertop") || cat.includes("slab");
    if (!isCountertop) {
      cleaned = cleaned.replace(/\s+\d+\s*[xX×]\s*\d+\s*$/, "");
    }
    cleaned = cleaned.replace(/\s+SPC\b/gi, "");
    cleaned = cleaned.replace(/\s+WPC\b/gi, "");
    cleaned = cleaned.replace(/\s+W\/?\s*pad\b/gi, "");
    cleaned = cleaned.replace(/\s+\d+\s*mil\b/gi, "");
    cleaned = cleaned.replace(/\s+\d+mm\b/gi, "");
    cleaned = cleaned.trim();
    if (cleaned.length < 3) return name;
    return cleaned;
  }
  function pdpSubtitle(sku) {
    if (sku.variant_type === "accessory") return formatVariantName(sku.variant_name);
    if (sku.variant_name && sku.variant_name.includes(",")) return formatVariantName(sku.variant_name);
    const attrs = sku.attributes || [];
    const titleName = cleanProductTitle(sku.product_name, sku) || sku.product_name || "";
    const titleLower = titleName.toLowerCase();
    const parts = [];
    const colorAttr = attrs.find((a) => a.slug === "color");
    if (colorAttr && colorAttr.value) {
      const colorVal = formatCarpetValue(colorAttr.value);
      if (!titleLower.includes(colorVal.toLowerCase())) {
        parts.push(colorVal);
      }
    }
    const sizeAttr = attrs.find((a) => a.slug === "size");
    if (sizeAttr && sizeAttr.value) {
      parts.push(formatSizeDim(sizeAttr.value));
    }
    const finishAttr = attrs.find((a) => a.slug === "finish");
    if (finishAttr && finishAttr.value) {
      const finishVal = formatCarpetValue(finishAttr.value);
      if (!titleLower.includes(finishVal.toLowerCase())) {
        parts.push(finishVal);
      }
    }
    if (parts.length === 0) return formatVariantName(sku.variant_name);
    return parts.join(", ");
  }
  function fullProductName(sku) {
    const rawName = sku.product_name || "";
    const col = sku.collection || "";
    let name = formatCarpetValue(rawName);
    if (sku.variant_type === "accessory") {
      let baseName = name;
      baseName = stripTypeSuffix(baseName, sku.category_name);
      const label = sku.accessory_label || sku.variant_name || "";
      return label ? baseName + " \u2014 " + label : baseName;
    }
    name = name.replace(/^\d+\s*[xX×]\s*\d+\w?\s+/, "");
    name = stripTypeSuffix(name, sku.category_name);
    if (sku.format_label) {
      name = name + " " + sku.format_label;
    }
    const TAXONOMY_COLLECTION_VENDORS = /* @__PURE__ */ new Set(["BELLEZZA"]);
    const TAXONOMY_COLLECTION_VENDOR_NAMES = /* @__PURE__ */ new Set(["BELLEZZA CERAMICA"]);
    const skipCollectionInTitle = TAXONOMY_COLLECTION_VENDORS.has((sku.vendor_code || "").toUpperCase()) || TAXONOMY_COLLECTION_VENDOR_NAMES.has((sku.vendor_name || "").toUpperCase());
    let showCollection = "";
    if (col && name && !skipCollectionInTitle) {
      const colLower = col.toLowerCase();
      const nameLower = name.toLowerCase();
      if (colLower === nameLower) {
        showCollection = "";
      } else if (colLower.startsWith(nameLower + " ") || colLower.startsWith(nameLower + "-")) {
        name = col;
        showCollection = "";
      } else if (nameLower.startsWith(colLower + " ") || nameLower.startsWith(colLower + "-")) {
        showCollection = "";
      } else if (nameLower.includes(" " + colLower + " ") || nameLower.endsWith(" " + colLower)) {
        showCollection = "";
      } else if (/\b(series|collection|edition)\b/i.test(name)) {
        showCollection = "";
        const colorAttr = (sku.attributes || []).find((a) => a.slug === "color");
        const _earlyResult = colorAttr && colorAttr.value ? name + " \u2014 " + colorAttr.value : name;
        return appendTypeSuffix(_earlyResult, sku.category_name);
      } else {
        const dashIdx = col.indexOf(" - ");
        if (dashIdx > 0) {
          const suffix = col.slice(dashIdx + 3).toLowerCase().trim();
          if (nameLower === suffix || nameLower.startsWith(suffix + " ") || nameLower.startsWith(suffix + "-")) {
            showCollection = col.slice(0, dashIdx);
          } else {
            showCollection = col;
          }
        } else {
          showCollection = col;
        }
      }
    }
    let variant = null;
    if (sku.variant_name) {
      const vLower = sku.variant_name.toLowerCase().trim();
      const vNorm = vLower.replace(/-/g, " ");
      const pLower = rawName.toLowerCase();
      const nLower = name.toLowerCase();
      if (vNorm === pLower || vNorm === nLower) {
        variant = null;
      } else if (vNorm.startsWith(pLower + " ") || vLower.startsWith(pLower + ",") || vLower.startsWith(pLower + "-")) {
        const suffix = sku.variant_name.replace(new RegExp("^" + rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s,\\-]+", "i"), "").trim();
        variant = suffix ? formatVariantName(suffix) : null;
      } else if (nLower !== pLower && (vNorm.startsWith(nLower + " ") || vLower.startsWith(nLower + ",") || vLower.startsWith(nLower + "-"))) {
        const suffix = sku.variant_name.replace(new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s,\\-]+", "i"), "").trim();
        variant = suffix ? formatVariantName(suffix) : null;
      } else if (pLower.startsWith(vNorm + " ") || pLower === vNorm) {
        variant = null;
      } else if (vNorm.length > 2 && (nLower.includes(" " + vNorm + " ") || nLower.endsWith(" " + vNorm) || nLower.startsWith(vNorm + " "))) {
        variant = null;
      } else {
        variant = formatVariantName(sku.variant_name);
      }
      if (variant) {
        const cParts = variant.split(",");
        if (cParts.length > 1) {
          const seg = cParts[0].trim().toLowerCase();
          if (seg.length > 1 && (nLower === seg || nLower.endsWith(" " + seg) || nLower.startsWith(seg + " ") || nLower.includes(" " + seg + " "))) {
            variant = cParts.slice(1).map((p) => p.trim()).join(", ") || null;
          }
        }
        if (variant) {
          const lastNameWord = nLower.split(/\s+/).pop();
          const firstVarWord = variant.split(/[\s,]+/)[0].toLowerCase();
          if (lastNameWord.length > 2 && firstVarWord === lastNameWord) {
            variant = variant.replace(/^\S+[\s,]*/, "").trim() || null;
          }
        }
      }
      if (variant) {
        const dimMatch = variant.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?(?:\s*(?:PAVER|EZ|FT))?)(\s*\(.*\))?$/i);
        if (dimMatch) {
          variant = formatSizeDim(dimMatch[1].trim()) + (dimMatch[2] || "");
        } else {
          const dimPrefixMatch = variant.match(/^(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s+(.+)$/);
          if (dimPrefixMatch) {
            variant = formatSizeDim(dimPrefixMatch[1].trim()) + ", " + dimPrefixMatch[2].trim();
          }
        }
      }
    }
    if (sku.attributes) {
      const colorAttr = (sku.attributes || []).find((a) => a.slug === "color");
      const variantIsColor = colorAttr && variant && variant.toLowerCase() === formatVariantName(colorAttr.value).toLowerCase();
      const variantIsEmpty = !variant && colorAttr && rawName.toLowerCase().includes(colorAttr.value.toLowerCase());
      if (variantIsColor || variantIsEmpty) {
        const rawSizeAttr = sku.sell_by !== "roll" ? (sku.attributes || []).find((a) => a.slug === "size") : null;
        const rawSizeVal = rawSizeAttr ? (rawSizeAttr.value || "").trim() : "";
        const isAdexVendor = (sku.vendor_code || "").toUpperCase() === "ADEX";
        const sizeAttr = rawSizeAttr && !isAdexVendor && (/^\d+\s*[xX×]\s*\d+\s*ft$/i.test(rawSizeVal) || /^\d+\.\d+\s*[xX×]\s*\d+\.\d+$/.test(rawSizeVal) || /^\d+\.\d+\s+Wide$/i.test(rawSizeVal) || /^\d+\s+in$/i.test(rawSizeVal) || /^\d+\u2033$/.test(rawSizeVal)) ? null : rawSizeAttr;
        const patternAttr = (sku.attributes || []).find((a) => a.slug === "pattern");
        const finishAttr = (sku.attributes || []).find((a) => a.slug === "finish");
        const nameLowerDedup = name.toLowerCase();
        const extras = [patternAttr, sizeAttr].filter(Boolean).filter((a) => !nameLowerDedup.includes(a.value.toLowerCase())).map((a) => a.value);
        if (extras.length > 0) {
          const sizePart = extras.join(" ");
          const colorVal = variantIsColor ? variant : null;
          const finishVal = finishAttr && finishAttr.value ? finishAttr.value : null;
          const finishPos = finishVal ? nameLowerDedup.indexOf(finishVal.toLowerCase()) : -1;
          if (finishPos > 0) {
            const before = name.slice(0, finishPos).trim();
            const after = name.slice(finishPos).trim();
            name = before + (colorVal ? " " + colorVal : "") + " " + sizePart + " " + after;
            if (colorVal) variant = null;
          } else {
            const colLc = (col || "").toLowerCase();
            if (colLc && name.toLowerCase().startsWith(colLc + " ")) {
              name = name.slice(0, col.length) + (colorVal ? " " + colorVal : "") + " " + sizePart + name.slice(col.length);
              if (colorVal) variant = null;
            } else {
              variant = (colorVal ? colorVal + " " : "") + sizePart;
            }
          }
        }
      }
    }
    if (sku.attributes) {
      const olAttr = (sku.attributes || []).find((a) => a.slug === "overall_length");
      if (olAttr && olAttr.value) {
        const olVal = olAttr.value.trim();
        if (!name.toLowerCase().includes(olVal.toLowerCase()) && !/\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*["″]/.test(name)) {
          name = name + " " + olVal;
        }
      }
    }
    let productLine = "";
    const plAttr = (sku.attributes || []).find((a) => a.slug === "product_line");
    if (plAttr && plAttr.value) {
      const plLower = plAttr.value.toLowerCase();
      const colLower = (showCollection || "").toLowerCase();
      const nameLower = name.toLowerCase();
      if (plLower !== colLower && plLower !== nameLower && !nameLower.includes(plLower) && !colLower.includes(plLower)) {
        productLine = plAttr.value;
      }
    }
    let brand = "";
    const brandAttr = (sku.attributes || []).find((a) => a.slug === "brand");
    if (brandAttr && brandAttr.value) {
      const bLower = brandAttr.value.toLowerCase();
      const colLower2 = (showCollection || "").toLowerCase();
      const nameLower2 = name.toLowerCase();
      const vendorLower = (sku.vendor_name || "").toLowerCase();
      if (bLower !== colLower2 && bLower !== nameLower2 && bLower !== vendorLower && !nameLower2.includes(bLower) && !colLower2.includes(bLower)) {
        brand = brandAttr.value;
      }
    }
    const subLineAttr = (sku.attributes || []).find((a) => a.slug === "sub_line");
    const subLineNumeral = subLineAttr && /^I{1,3}$/.test(subLineAttr.value) ? subLineAttr.value : null;
    let orderedName = name;
    let orderedVariant = variant;
    if (variant) {
      const sizeMatch = name.match(/^(.*?\s)?(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?\s*[xX×]\s*\d.*)$/);
      if (sizeMatch && sizeMatch[2]) {
        const prefix = (sizeMatch[1] || "").trimEnd();
        orderedName = (prefix ? prefix + " " : "") + variant + " " + sizeMatch[2];
        orderedVariant = null;
      }
    }
    const result = [brand, showCollection, productLine, orderedName, orderedVariant, subLineNumeral].filter(Boolean).join(" ");
    return appendTypeSuffix(result, sku.category_name);
  }
  function cleanDescription(text, vendorName) {
    if (!text) return "";
    let cleaned = text;
    const boilerplatePatterns = [
      /\s*at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s+we\s+have\s+.*/i,
      /\s*visit\s+(?:us\s+at\s+)?(?:www\.)?[\w.-]+\.\w+\s*.*/i,
      /\s*available\s+(?:exclusively\s+)?at\s+\w[\w\s]*(?:tile|surfaces|flooring)\s*.*/i,
      /\s*(?:shop|browse|explore)\s+(?:our\s+)?(?:full\s+)?(?:selection|collection|range)\s+at\s+.*/i,
      /\s*whether\s+you\s+are\s+building\s+your\s+dream\s+space\s*.*/i
    ];
    for (const pattern of boilerplatePatterns) {
      cleaned = cleaned.replace(pattern, "");
    }
    if (vendorName) {
      const escapedVendor = vendorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const vendorPromo = new RegExp("\\s*(?:at|from|by)\\s+" + escapedVendor + "\\s+we\\s+.*", "i");
      cleaned = cleaned.replace(vendorPromo, "");
    }
    return cleaned.trim();
  }
  function StockBadge({ status, vendorHasInventory, qtyOnHand, qtyOnHandSqft, sellBy }) {
    if (vendorHasInventory === false && (status === "unknown" || status === "out_of_stock")) {
      return React.createElement(
        "div",
        { className: "pdp-stock-badge out-of-stock" },
        React.createElement("span", { className: "pdp-stock-dot" }),
        "Call for availability"
      );
    }
    let lowStockLabel = "Low Stock \u2014 Order Soon";
    if (status === "low_stock" && qtyOnHand != null && qtyOnHand > 0) {
      if (sellBy === "unit") {
        lowStockLabel = "Only " + qtyOnHand + " left \u2014 Order Soon";
      } else if (sellBy === "box" && qtyOnHandSqft) {
        lowStockLabel = "Only " + qtyOnHand + " boxes left (" + Math.round(qtyOnHandSqft) + " sqft) \u2014 Order Soon";
      } else if (sellBy === "roll") {
        lowStockLabel = "Only " + (qtyOnHandSqft ? Math.round(qtyOnHandSqft) + " sqft" : qtyOnHand + " rolls") + " left \u2014 Order Soon";
      } else {
        lowStockLabel = "Only " + qtyOnHand + " left \u2014 Order Soon";
      }
    }
    const map = {
      in_stock: { label: "In Stock", cls: "in-stock" },
      low_stock: { label: lowStockLabel, cls: "low-stock" },
      out_of_stock: { label: "Out of Stock", cls: "out-of-stock" },
      discontinued: { label: "Discontinued", cls: "discontinued" }
    };
    const info = map[status] || { label: "Check Availability", cls: "out-of-stock" };
    return React.createElement(
      "div",
      { className: `pdp-stock-badge ${info.cls}` },
      React.createElement("span", { className: "pdp-stock-dot" }),
      info.label
    );
  }
  function StarDisplay({ rating, size = 16, color = "#c8a97e" }) {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      const fill = i <= Math.round(rating) ? color : "#d6d3d1";
      stars.push(React.createElement(
        "svg",
        { key: i, width: size, height: size, viewBox: "0 0 24 24", fill, xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" })
      ));
    }
    return React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "2px" } }, stars);
  }
  let stripeInstance = null;
  let _stripeInitPromise = null;
  function ensureStripe() {
    if (stripeInstance) return Promise.resolve(stripeInstance);
    if (_stripeInitPromise) return _stripeInitPromise;
    _stripeInitPromise = (async () => {
      for (let i = 0; i < 100 && typeof Stripe === "undefined"; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (typeof Stripe === "undefined") {
        _stripeInitPromise = null;
        return null;
      }
      try {
        const r = await fetch((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:3001" : "") + "/api/config/stripe-key");
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        if (data.key) stripeInstance = Stripe(data.key);
      } catch (e) {
        console.warn("Failed to load Stripe key:", e);
        _stripeInitPromise = null;
      }
      return stripeInstance;
    })();
    return _stripeInitPromise;
  }
  ensureStripe();
  let _placesPromise = null;
  function loadGooglePlaces(apiKey) {
    if (_placesPromise) return _placesPromise;
    if (window.google && window.google.maps && window.google.maps.places) {
      _placesPromise = Promise.resolve();
      return _placesPromise;
    }
    _placesPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(apiKey) + "&libraries=places";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => {
        _placesPromise = null;
        reject(new Error("Failed to load Google Places"));
      };
      document.head.appendChild(script);
    });
    return _placesPromise;
  }
  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { hasError: false, errorMsg: "" };
    }
    static getDerivedStateFromError(error) {
      return { hasError: true, errorMsg: error && (error.stack || error.message || String(error)) };
    }
    componentDidCatch(error, info) {
      console.error("ErrorBoundary caught:", error, info);
    }
    render() {
      if (this.state.hasError) {
        return React.createElement(
          "div",
          {
            style: { maxWidth: 800, margin: "6rem auto", textAlign: "center", padding: "2rem", fontFamily: "'Inter', system-ui, sans-serif" }
          },
          React.createElement("div", { style: { fontSize: "4rem", marginBottom: "1rem", color: "#a8a29e" } }, "\u26A0"),
          React.createElement("h1", { style: { fontFamily: "'Cormorant Garamond', serif", fontSize: "2rem", fontWeight: 300, marginBottom: "0.75rem" } }, "Something Went Wrong"),
          React.createElement(
            "pre",
            { style: { color: "#dc2626", textAlign: "left", background: "#fef2f2", padding: "1rem", fontSize: "0.75rem", overflow: "auto", maxHeight: "300px", marginBottom: "1rem", border: "1px solid #fca5a5", borderRadius: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
            this.state.errorMsg || "Unknown error"
          ),
          React.createElement("button", {
            onClick: () => window.location.reload(),
            style: { display: "inline-block", padding: "1rem 3rem", background: "#1c1917", color: "white", border: "none", fontSize: "0.8125rem", textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer", fontFamily: "'Inter', system-ui, sans-serif" }
          }, "Refresh Page")
        );
      }
      return this.props.children;
    }
  }
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
      }, { threshold: options.threshold || 0.15, rootMargin: options.rootMargin || "-60px" });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    return [ref, isVisible];
  }
  function RevealSection({ children, delay = 0, className = "" }) {
    const [ref, isVisible] = useRevealOnScroll();
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        ref,
        className: "reveal-section " + className,
        style: {
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? "translateY(0)" : "translateY(var(--fade-up-distance, 30px))",
          transition: `opacity var(--fade-duration, 0.7s) cubic-bezier(0.22,1,0.36,1) ${delay}s, transform var(--fade-duration, 0.7s) cubic-bezier(0.22,1,0.36,1) ${delay}s`
        }
      },
      children
    );
  }
  function materialFace(kind, tone) {
    const T = tone || {};
    const A = T.a || "#c8b094";
    const B = T.b || "#7a6850";
    const C = T.c || "#3a3127";
    switch (kind) {
      case "wood":
        return { background: `repeating-linear-gradient(92deg, ${A} 0 7px, ${B} 7px 9px, ${A} 9px 22px, ${C}55 22px 23px, ${A} 23px 41px, ${B} 41px 43px), linear-gradient(180deg, ${A}, ${B})`, backgroundBlendMode: "multiply" };
      case "marble":
        return { background: `radial-gradient(120% 80% at 30% 20%, ${A} 0%, ${A} 30%, ${B}88 55%, ${A} 70%), radial-gradient(80% 60% at 70% 80%, ${C}55, transparent 60%), linear-gradient(135deg, ${A}, ${B}44)` };
      case "tile":
        return { background: `repeating-linear-gradient(0deg, ${C}22 0 0.5px, transparent 0.5px 60px), repeating-linear-gradient(90deg, ${C}22 0 0.5px, transparent 0.5px 60px), radial-gradient(60% 80% at 40% 30%, ${A}, ${B})` };
      case "stone":
        return { background: `radial-gradient(40% 60% at 25% 30%, ${A}, ${B} 80%), radial-gradient(30% 30% at 70% 60%, ${A}88, transparent), radial-gradient(20% 20% at 50% 80%, ${C}55, transparent), ${B}` };
      case "lvp":
        return { background: `repeating-linear-gradient(95deg, ${A} 0 14px, ${B}77 14px 15px, ${A} 15px 30px), linear-gradient(180deg, ${A}, ${B})`, backgroundBlendMode: "multiply" };
      case "quartz":
        return { background: `radial-gradient(2px 2px at 20% 30%, ${C}55, transparent), radial-gradient(2px 2px at 60% 20%, ${C}55, transparent), radial-gradient(3px 3px at 80% 60%, ${C}77, transparent), radial-gradient(2px 2px at 30% 70%, ${C}55, transparent), radial-gradient(2px 2px at 50% 50%, ${C}55, transparent), linear-gradient(135deg, ${A}, ${B}44)` };
      default:
        return { background: A };
    }
  }
  const CAB_BRANDS = {
    waypoint: {
      id: "waypoint",
      name: "Waypoint",
      tagline: "Living Spaces",
      origin: "Cumberland, MD \xB7 American Woodmark",
      framing: "framed",
      framingLabel: "Face-frame construction",
      framingNote: "Traditional American build. Visible frame around the door opening keeps fronts perfectly aligned for decades.",
      pitch: "Painted maple and stained oak, built by hand in the United States \u2014 soft-close standard, dent-resistant UV-catalytic paint, lifetime warranty.",
      bestFor: "Classic \xB7 Transitional \xB7 Traditional kitchens",
      doors: [
        { id: "shaker", name: "Hawthorne Shaker", profile: "shaker" },
        { id: "recessed", name: "Maple Recessed", profile: "recessed" },
        { id: "raised", name: "Sonoma Raised", profile: "raised" },
        { id: "beaded", name: "Linen Beaded", profile: "beaded" },
        { id: "arch", name: "Hartwell Arched", profile: "arched" },
        { id: "mullion", name: "Vienna Mullion", profile: "mullion" }
      ],
      finishes: [
        { id: "white", name: "Painted White", family: "painted", fill: "#f7f2e8" },
        { id: "linen", name: "Painted Linen", family: "painted", fill: "#f1ebd9" },
        { id: "oat", name: "Painted Oat", family: "painted", fill: "#e3d8b8" },
        { id: "hazelnut", name: "Painted Hazelnut", family: "painted", fill: "#c9b694" },
        { id: "sage", name: "Painted Sage", family: "painted", fill: "#a8b095" },
        { id: "fern", name: "Painted Fern", family: "painted", fill: "#7a8769" },
        { id: "olive", name: "Painted Olive", family: "painted", fill: "#56603e" },
        { id: "bluestone", name: "Painted Bluestone", family: "painted", fill: "#6a7a85" },
        { id: "slate", name: "Painted Slate", family: "painted", fill: "#3e4856" },
        { id: "cinnamon", name: "Painted Cinnamon", family: "painted", fill: "#a26a4a" },
        { id: "charcoalp", name: "Painted Charcoal", family: "painted", fill: "#33312e" },
        { id: "black", name: "Painted Black", family: "painted", fill: "#1a1815" },
        { id: "natmaple", name: "Natural Maple", family: "stained", species: "maple", fill: "#d9b988", wood: true, tone: { a: "#d9b988", b: "#a07d4e", c: "#5a4022" } },
        { id: "cider", name: "Maple Cider", family: "stained", species: "maple", fill: "#a87b4a", wood: true, tone: { a: "#caa97f", b: "#7a5635", c: "#3a2814" } },
        { id: "cocoa", name: "Maple Cocoa", family: "stained", species: "maple", fill: "#704024", wood: true, tone: { a: "#8a5e3a", b: "#4a2818", c: "#1c0e07" } },
        { id: "espresso", name: "Maple Espresso", family: "stained", species: "maple", fill: "#3a2418", wood: true, tone: { a: "#5a3a26", b: "#2a1c12", c: "#0a0604" } },
        { id: "natural", name: "Natural Oak", family: "stained", species: "oak", fill: "#caa97f", wood: true, tone: { a: "#caa97f", b: "#7a5635", c: "#3a2814" } },
        { id: "honey", name: "Honey Oak", family: "stained", species: "oak", fill: "#b8884c", wood: true, tone: { a: "#b8884c", b: "#7a5424", c: "#3a280a" } },
        { id: "saddle", name: "Saddle Oak", family: "stained", species: "oak", fill: "#8a5d2e", wood: true, tone: { a: "#a86e3a", b: "#6a3c16", c: "#2a1c08" } },
        { id: "coffee", name: "Coffee Oak", family: "stained", species: "oak", fill: "#4a2e1a", wood: true, tone: { a: "#6e4a30", b: "#3e2412", c: "#1a0e06" } },
        { id: "cherry", name: "Aged Cherry", family: "stained", species: "cherry", fill: "#8a4a30", wood: true, tone: { a: "#a86848", b: "#5a3018", c: "#2a140a" } },
        { id: "bordeaux", name: "Bordeaux Cherry", family: "stained", species: "cherry", fill: "#5a2418", wood: true, tone: { a: "#7a3624", b: "#3a160c", c: "#180806" } },
        { id: "hickory", name: "Natural Hickory", family: "stained", species: "hickory", fill: "#bf9670", wood: true, tone: { a: "#d4b08a", b: "#6a4226", c: "#2a1a0e" } },
        { id: "smoked", name: "Smoked Hickory", family: "stained", species: "hickory", fill: "#5a4632", wood: true, tone: { a: "#7a5e44", b: "#3a2c1e", c: "#1a120c" } },
        { id: "charcoal", name: "Charcoal Stain", family: "stained", species: "oak", fill: "#3a3530", wood: true, tone: { a: "#5a5048", b: "#2a241e", c: "#0a0808" } }
      ],
      hardware: [
        { id: "knob", name: "Round Knob" },
        { id: "bar", name: "Bar Pull" },
        { id: "cup", name: "Cup Pull" }
      ],
      defaults: { door: "shaker", finish: "linen", hardware: "knob" },
      warranty: "Lifetime",
      lead: "5\u20137 weeks",
      startingAt: "$240 / lf",
      stat: { v: "420+", l: "Sample doors stocked" }
    },
    europa: {
      id: "europa",
      name: "Europa",
      tagline: "Cabinetry",
      origin: "Italian-engineered",
      framing: "frameless",
      framingLabel: "Frameless full-access",
      framingNote: "No face frame. Doors and drawers mount directly to the box, returning ~15% of the interior to you.",
      pitch: "Slab fronts, integrated handles, push-to-open and soft-close throughout. Every appliance can be panel-ready.",
      bestFor: "Modern \xB7 Contemporary \xB7 Minimal kitchens",
      doors: [
        { id: "slab", name: "Linea Slab", profile: "slab" },
        { id: "channel", name: "Vetro Channel", profile: "channel" },
        { id: "slim", name: "Atmosfera Slim", profile: "slim" },
        { id: "gloss", name: "Tribeca High-Gloss", profile: "slab", sheen: "gloss" },
        { id: "reeded", name: "Onda Reeded", profile: "reeded" },
        { id: "glass", name: "Vetrina Glass", profile: "glass" }
      ],
      finishes: [
        { id: "snow", name: "Snow Matte", family: "matte", fill: "#ece8df" },
        { id: "ivory", name: "Ivory Matte", family: "matte", fill: "#e8dfc8" },
        { id: "linenm", name: "Linen Matte", family: "matte", fill: "#d8ccb2" },
        { id: "sand", name: "Sand Matte", family: "matte", fill: "#cbbf9e" },
        { id: "stone", name: "Stone Matte", family: "matte", fill: "#a59f8a" },
        { id: "sagem", name: "Sage Matte", family: "matte", fill: "#8e9a82" },
        { id: "olivem", name: "Olive Matte", family: "matte", fill: "#5e6644" },
        { id: "fog", name: "Fog Grey", family: "matte", fill: "#9aa0a3" },
        { id: "cement", name: "Cement", family: "matte", fill: "#666560" },
        { id: "graphite", name: "Graphite", family: "matte", fill: "#2a2c2e" },
        { id: "carbon", name: "Carbon Matte", family: "matte", fill: "#16171a" },
        { id: "cobalt", name: "Cobalt Matte", family: "matte", fill: "#2c3a5e" },
        { id: "terracotta", name: "Terracotta Matte", family: "matte", fill: "#a85838" },
        { id: "bordeauxm", name: "Bordeaux Matte", family: "matte", fill: "#5a2424" },
        { id: "glosswhite", name: "High-Gloss White", family: "gloss", fill: "#fafaf5" },
        { id: "glossblack", name: "High-Gloss Black", family: "gloss", fill: "#16171a" },
        { id: "glosspearl", name: "High-Gloss Pearl", family: "gloss", fill: "#e8e4d8" },
        { id: "oakv", name: "White Oak Veneer", family: "veneer", species: "oak", fill: "#caa97f", wood: true, tone: { a: "#caa97f", b: "#7a5635", c: "#3a2814" } },
        { id: "walnut", name: "Walnut Veneer", family: "veneer", species: "walnut", fill: "#6a3818", wood: true, tone: { a: "#8a5e3a", b: "#4a2818", c: "#1c0e07" } },
        { id: "smokedv", name: "Smoked Oak Veneer", family: "veneer", species: "oak", fill: "#3a2e22", wood: true, tone: { a: "#5a4a36", b: "#2c1f14", c: "#0e0806" } },
        { id: "cerused", name: "Cerused Oak", family: "veneer", species: "oak", fill: "#b8a890", wood: true, tone: { a: "#d4c4a8", b: "#8a7e64", c: "#3a3424" } },
        { id: "beton", name: "B\xE9ton Concrete", family: "textured", fill: "#8a8682" },
        { id: "brass", name: "Patina Brass", family: "textured", fill: "#a87a3a" }
      ],
      hardware: [
        { id: "integrated", name: "Integrated Channel" },
        { id: "bar", name: "Slim Bar Pull" },
        { id: "none", name: "Push-to-Open" }
      ],
      defaults: { door: "slab", finish: "snow", hardware: "integrated" },
      warranty: "10-year",
      lead: "4\u20136 weeks",
      startingAt: "$320 / lf",
      stat: { v: "+15%", l: "Accessible interior" }
    }
  };
  function cabBtn(bg, fg, kind, theme) {
    if (kind === "primary") return {
      padding: "14px 22px",
      background: bg,
      color: fg,
      border: "none",
      borderRadius: 999,
      font: "500 12px/1 var(--font-body)",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      cursor: "pointer",
      whiteSpace: "nowrap",
      transition: "opacity 0.2s, transform 0.2s"
    };
    return {
      padding: "13px 21px",
      background: "transparent",
      color: theme.ink,
      border: `0.5px solid ${theme.ink}33`,
      borderRadius: 999,
      font: "500 12px/1 var(--font-body)",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      cursor: "pointer",
      whiteSpace: "nowrap",
      transition: "background 0.2s, color 0.2s, border-color 0.2s"
    };
  }
  function CabSectionHead({ theme, num, eyebrow, headline, sub, align = "left" }) {
    const { ink, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("div", { style: { textAlign: align, marginBottom: 56 } }, /* @__PURE__ */ React.createElement("div", { style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      font: "500 10px/1 ui-monospace, monospace",
      letterSpacing: "0.22em",
      textTransform: "uppercase",
      color: muted,
      marginBottom: 22
    } }, /* @__PURE__ */ React.createElement("span", { style: { color: accent } }, num), /* @__PURE__ */ React.createElement("span", { style: { width: 24, height: 1, background: `${ink}22` } }), /* @__PURE__ */ React.createElement("span", null, eyebrow)), /* @__PURE__ */ React.createElement("h2", { style: {
      font: "300 56px/1.18 var(--font-heading)",
      margin: 0,
      letterSpacing: "-0.018em",
      textWrap: "pretty",
      color: ink
    } }, headline), sub && /* @__PURE__ */ React.createElement("p", { style: {
      font: "400 17px/1.55 var(--font-body)",
      color: `${ink}dd`,
      margin: "36px 0 0",
      maxWidth: 640,
      ...align === "center" ? { marginLeft: "auto", marginRight: "auto" } : {}
    } }, sub));
  }
  function CabinetSpecimen({ theme, brand, door, finish, hardware, softClose, big }) {
    const { ink, paper, accent, muted } = theme;
    const B = CAB_BRANDS[brand];
    const D = B.doors.find((d) => d.id === door) || B.doors[0];
    const F = B.finishes.find((f) => f.id === finish) || B.finishes[0];
    const H = B.hardware.find((h) => h.id === hardware) || B.hardware[0];
    const framed = B.framing === "framed";
    const gloss = D.sheen === "gloss" || F.family === "gloss";
    const VB_W = 640, VB_H = 720;
    const X0 = 30, X1 = 610, Y0 = 50, Y1 = 660;
    const FR = framed ? 18 : 2;
    const DR_Y0 = Y0 + FR, DR_Y1 = DR_Y0 + 100;
    const DOORS_Y0 = DR_Y1 + FR, DOORS_Y1 = Y1 - FR;
    const MIDX = (X0 + X1) / 2;
    const finishFillId = `cab-fill-${brand}-${F.id}-${gloss ? "g" : "m"}`;
    const woodPatternId = `cab-wood-${brand}-${F.id}`;
    const useWood = !!F.wood;
    const faceFill = useWood ? `url(#${woodPatternId})` : `url(#${finishFillId})`;
    const renderDoor = (x0, y0, x1, y1, isDrawer) => /* @__PURE__ */ React.createElement("g", { key: `${x0}-${y0}` }, /* @__PURE__ */ React.createElement("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: faceFill, stroke: ink, strokeOpacity: "0.18", strokeWidth: "0.5" }), gloss && /* @__PURE__ */ React.createElement("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: `url(#${finishFillId}-gloss)` }), F.family === "textured" && /* @__PURE__ */ React.createElement("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: "url(#cab-texture-noise)", opacity: "0.4" }), (D.profile === "shaker" || D.profile === "recessed" || D.profile === "slim") && (() => {
      const inset = D.profile === "slim" ? 10 : D.profile === "shaker" ? 26 : 22;
      const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? Math.min(inset, 14) : inset);
      const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? Math.min(inset, 14) : inset);
      return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0, fill: "rgba(0,0,0,0.06)" }), /* @__PURE__ */ React.createElement("line", { x1: ix0, y1: iy0, x2: ix1, y2: iy0, stroke: "rgba(0,0,0,0.18)", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: ix0, y1: iy0, x2: ix0, y2: iy1, stroke: "rgba(0,0,0,0.14)", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: ix1, y1: iy0, x2: ix1, y2: iy1, stroke: "rgba(255,255,255,0.35)", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: ix0, y1: iy1, x2: ix1, y2: iy1, stroke: "rgba(255,255,255,0.35)", strokeWidth: "0.5" }));
    })(), D.profile === "raised" && (() => {
      const inset = 22;
      const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? 12 : inset);
      const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? 12 : inset);
      const ch = 14;
      return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("polygon", { points: `${ix0 + ch},${iy0 + ch} ${ix1 - ch},${iy0 + ch} ${ix1 - ch},${iy1 - ch} ${ix0 + ch},${iy1 - ch}`, fill: "rgba(255,255,255,0.18)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix0},${iy0} ${ix1},${iy0} ${ix1 - ch},${iy0 + ch} ${ix0 + ch},${iy0 + ch}`, fill: "rgba(255,255,255,0.18)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix0},${iy1} ${ix1},${iy1} ${ix1 - ch},${iy1 - ch} ${ix0 + ch},${iy1 - ch}`, fill: "rgba(0,0,0,0.16)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix0},${iy0} ${ix0 + ch},${iy0 + ch} ${ix0 + ch},${iy1 - ch} ${ix0},${iy1}`, fill: "rgba(0,0,0,0.08)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix1},${iy0} ${ix1 - ch},${iy0 + ch} ${ix1 - ch},${iy1 - ch} ${ix1},${iy1}`, fill: "rgba(255,255,255,0.08)" }));
    })(), D.profile === "beaded" && (() => {
      const inset = 18;
      const ix0 = x0 + inset, iy0 = y0 + (isDrawer ? 10 : inset);
      const ix1 = x1 - inset, iy1 = y1 - (isDrawer ? 10 : inset);
      return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0, fill: "rgba(0,0,0,0.04)" }), /* @__PURE__ */ React.createElement("rect", { x: ix0 + 6, y: iy0 + 6, width: ix1 - ix0 - 12, height: iy1 - iy0 - 12, fill: "none", stroke: "rgba(0,0,0,0.25)", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("rect", { x: ix0 + 8, y: iy0 + 8, width: ix1 - ix0 - 16, height: iy1 - iy0 - 16, fill: "none", stroke: "rgba(255,255,255,0.25)", strokeWidth: "0.5" }));
    })(), D.profile === "channel" && /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: x0, y: y0, width: x1 - x0, height: 10, fill: "rgba(0,0,0,0.32)" }), /* @__PURE__ */ React.createElement("rect", { x: x0 + 4, y: y0 + 2, width: x1 - x0 - 8, height: 6, fill: "rgba(0,0,0,0.45)" })), D.profile === "reeded" && (() => {
      const w = x1 - x0;
      const count = Math.max(10, Math.floor(w / 14));
      const step = w / count;
      return /* @__PURE__ */ React.createElement("g", null, Array.from({ length: count + 1 }).map((_, i) => /* @__PURE__ */ React.createElement("line", { key: i, x1: x0 + i * step, y1: y0 + 2, x2: x0 + i * step, y2: y1 - 2, stroke: "rgba(0,0,0,0.18)", strokeWidth: "0.6" })), Array.from({ length: count }).map((_, i) => /* @__PURE__ */ React.createElement("line", { key: `h${i}`, x1: x0 + i * step + step / 2, y1: y0 + 4, x2: x0 + i * step + step / 2, y2: y1 - 4, stroke: "rgba(255,255,255,0.12)", strokeWidth: "0.5" })));
    })(), D.profile === "glass" && !isDrawer && (() => {
      const ix0 = x0 + 14, iy0 = y0 + 14, ix1 = x1 - 14, iy1 = y1 - 14;
      const midX = (ix0 + ix1) / 2, midY = (iy0 + iy1) / 2;
      return /* @__PURE__ */ React.createElement("g", { stroke: "rgba(0,0,0,0.28)", strokeWidth: "1", fill: "rgba(255,255,255,0.18)" }, /* @__PURE__ */ React.createElement("rect", { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 }), /* @__PURE__ */ React.createElement("line", { x1: midX, y1: iy0, x2: midX, y2: iy1 }), /* @__PURE__ */ React.createElement("line", { x1: ix0, y1: midY, x2: ix1, y2: midY }), /* @__PURE__ */ React.createElement("line", { x1: ix0 + 12, y1: iy0 + 12, x2: ix0 + 60, y2: iy0 + 60, stroke: "rgba(255,255,255,0.45)", strokeWidth: "1" }));
    })(), D.profile === "mullion" && !isDrawer && (() => {
      const ix0 = x0 + 16, iy0 = y0 + 16, ix1 = x1 - 16, iy1 = y1 - 16;
      return /* @__PURE__ */ React.createElement("g", { stroke: "rgba(0,0,0,0.3)", strokeWidth: "1.2", fill: "rgba(0,0,0,0.06)" }, /* @__PURE__ */ React.createElement("rect", { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 }), /* @__PURE__ */ React.createElement("line", { x1: (ix0 + ix1) / 2, y1: iy0, x2: (ix0 + ix1) / 2, y2: iy1, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("line", { x1: ix0, y1: (iy0 + iy1) / 2, x2: ix1, y2: (iy0 + iy1) / 2, strokeWidth: "1" }));
    })(), D.profile === "arched" && !isDrawer && (() => {
      const inset = 18;
      const ix0 = x0 + inset, ix1 = x1 - inset, iy1 = y1 - inset;
      const arcStartY = y0 + 80;
      const path = `M ${ix0} ${iy1} L ${ix0} ${arcStartY} Q ${ix0} ${y0 + inset} ${(ix0 + ix1) / 2} ${y0 + inset} Q ${ix1} ${y0 + inset} ${ix1} ${arcStartY} L ${ix1} ${iy1} Z`;
      return /* @__PURE__ */ React.createElement("path", { d: path, fill: "rgba(0,0,0,0.06)", stroke: "rgba(0,0,0,0.22)", strokeWidth: "0.7" });
    })());
    const renderHardware = (cx, cy, kind) => {
      if (kind === "none" || kind === "integrated") return null;
      if (kind === "knob") return /* @__PURE__ */ React.createElement("circle", { cx, cy, r: "5", fill: ink });
      if (kind === "bar") return /* @__PURE__ */ React.createElement("rect", { x: cx - 40, y: cy - 3, width: "80", height: "6", rx: "3", fill: ink });
      if (kind === "cup") return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("path", { d: `M ${cx - 32} ${cy - 4} L ${cx - 32} ${cy + 6} Q ${cx} ${cy + 14}, ${cx + 32} ${cy + 6} L ${cx + 32} ${cy - 4} Z`, fill: ink, fillOpacity: "0.85" }), /* @__PURE__ */ React.createElement("rect", { x: cx - 32, y: cy - 5, width: "64", height: "3", fill: ink }));
      return null;
    };
    return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, style: { width: "100%", height: "100%", display: "block" } }, /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement("linearGradient", { id: finishFillId, x1: "0", y1: "0", x2: "0", y2: "1" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: F.fill, stopOpacity: "1" }), /* @__PURE__ */ React.createElement("stop", { offset: "60%", stopColor: F.fill, stopOpacity: "1" }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: F.fill, stopOpacity: F.family === "matte" ? 0.94 : 1 })), /* @__PURE__ */ React.createElement("linearGradient", { id: `${finishFillId}-gloss`, x1: "0", y1: "0", x2: "1", y2: "1" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "rgba(255,255,255,0.55)" }), /* @__PURE__ */ React.createElement("stop", { offset: "35%", stopColor: "rgba(255,255,255,0.05)" }), /* @__PURE__ */ React.createElement("stop", { offset: "65%", stopColor: "rgba(0,0,0,0.05)" }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "rgba(0,0,0,0.28)" })), F.wood && /* @__PURE__ */ React.createElement("pattern", { id: woodPatternId, patternUnits: "userSpaceOnUse", width: "80", height: "16", patternTransform: "rotate(90)" }, /* @__PURE__ */ React.createElement("rect", { width: "80", height: "16", fill: F.tone.a }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "5", width: "80", height: "0.8", fill: F.tone.c, opacity: "0.55" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "11", width: "80", height: "0.6", fill: F.tone.c, opacity: "0.35" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "2", width: "80", height: "0.4", fill: F.tone.b, opacity: "0.45" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: "0.6", height: "16", fill: F.tone.c, opacity: "0.4" }), /* @__PURE__ */ React.createElement("rect", { x: "38", y: "0", width: "0.6", height: "16", fill: F.tone.c, opacity: "0.32" }), /* @__PURE__ */ React.createElement("ellipse", { cx: "60", cy: "8", rx: "6", ry: "3", fill: F.tone.b, opacity: "0.22" })), /* @__PURE__ */ React.createElement("pattern", { id: "cab-texture-noise", patternUnits: "userSpaceOnUse", width: "8", height: "8" }, /* @__PURE__ */ React.createElement("rect", { width: "8", height: "8", fill: "none" }), /* @__PURE__ */ React.createElement("circle", { cx: "2", cy: "3", r: "0.6", fill: "rgba(0,0,0,0.5)" }), /* @__PURE__ */ React.createElement("circle", { cx: "6", cy: "5", r: "0.5", fill: "rgba(255,255,255,0.35)" }), /* @__PURE__ */ React.createElement("circle", { cx: "4", cy: "7", r: "0.4", fill: "rgba(0,0,0,0.3)" })), /* @__PURE__ */ React.createElement("pattern", { id: "cab-hatch", patternUnits: "userSpaceOnUse", width: "6", height: "6", patternTransform: "rotate(45)" }, /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "0", x2: "0", y2: "6", stroke: ink, strokeWidth: "0.5", strokeOpacity: "0.55" }))), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: VB_W, height: "38", fill: `${ink}11` }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "38", width: VB_W, height: "6", fill: ink }), /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "44", x2: VB_W, y2: "44", stroke: paper, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("rect", { x: X0, y: Y0, width: X1 - X0, height: Y1 - Y0, fill: ink, fillOpacity: "0.04" }), framed && /* @__PURE__ */ React.createElement("g", { fill: "url(#cab-hatch)" }, /* @__PURE__ */ React.createElement("rect", { x: X0, y: Y0, width: FR, height: Y1 - Y0 }), /* @__PURE__ */ React.createElement("rect", { x: X1 - FR, y: Y0, width: FR, height: Y1 - Y0 }), /* @__PURE__ */ React.createElement("rect", { x: X0, y: Y0, width: X1 - X0, height: FR }), /* @__PURE__ */ React.createElement("rect", { x: X0, y: DR_Y1, width: X1 - X0, height: FR }), /* @__PURE__ */ React.createElement("rect", { x: X0, y: Y1 - FR, width: X1 - X0, height: FR }), /* @__PURE__ */ React.createElement("rect", { x: MIDX - FR / 2, y: DOORS_Y0, width: FR, height: DOORS_Y1 - DOORS_Y0 })), framed ? renderDoor(X0 + FR, DR_Y0, X1 - FR, DR_Y1, true) : renderDoor(X0 + 2, DR_Y0, X1 - 2, DR_Y1, true), framed ? renderDoor(X0 + FR, DOORS_Y0, MIDX - FR / 2, DOORS_Y1, false) : renderDoor(X0 + 2, DOORS_Y0, MIDX - 2, DOORS_Y1, false), framed ? renderDoor(MIDX + FR / 2, DOORS_Y0, X1 - FR, DOORS_Y1, false) : renderDoor(MIDX + 2, DOORS_Y0, X1 - 2, DOORS_Y1, false), H.id !== "integrated" && H.id !== "none" && D.profile !== "channel" && renderHardware((X0 + X1) / 2, (DR_Y0 + DR_Y1) / 2, H.id), H.id !== "integrated" && H.id !== "none" && D.profile !== "channel" && (() => {
      const door1x = MIDX - FR / 2 - (H.id === "knob" ? 24 : 70);
      const door2x = MIDX + FR / 2 + (H.id === "knob" ? 24 : 70);
      const knobY = DOORS_Y0 + 60;
      if (H.id === "knob") return /* @__PURE__ */ React.createElement("g", null, renderHardware(door1x, knobY, "knob"), renderHardware(door2x, knobY, "knob"));
      const x1c = MIDX - FR / 2 - 22, x2c = MIDX + FR / 2 + 22;
      const hy0 = DOORS_Y0 + 40, hy1 = hy0 + 100;
      return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: x1c - 3, y: hy0, width: "6", height: hy1 - hy0, rx: "3", fill: ink }), /* @__PURE__ */ React.createElement("rect", { x: x2c - 3, y: hy0, width: "6", height: hy1 - hy0, rx: "3", fill: ink }));
    })(), /* @__PURE__ */ React.createElement("rect", { x: X0 + 12, y: Y1, width: X1 - X0 - 24, height: VB_H - Y1 - 4, fill: ink, fillOpacity: "0.6" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: VB_H - 4, width: VB_W, height: "4", fill: ink, fillOpacity: "0.12" }), /* @__PURE__ */ React.createElement("g", { fill: ink, fillOpacity: "0.45", fontFamily: "ui-monospace, monospace", fontSize: "9", letterSpacing: "0.16em" }, /* @__PURE__ */ React.createElement("text", { x: X0, y: VB_H - 14, stroke: "none" }, '36" W \xB7 34.5" H \xB7 24" D'), /* @__PURE__ */ React.createElement("text", { x: X1, y: VB_H - 14, stroke: "none", textAnchor: "end" }, B.framingLabel.toUpperCase())), softClose && /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: X1 - 168, y: Y0 + 14, width: "146", height: "22", rx: "11", fill: paper, stroke: accent, strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("circle", { cx: X1 - 154, cy: Y0 + 25, r: "3", fill: accent }), /* @__PURE__ */ React.createElement("text", { x: X1 - 144, y: Y0 + 28, fontSize: "9", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, stroke: "none" }, "SOFT-CLOSE ACTIVE")), /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: "0", y: VB_H - 30, width: "120", height: "22", fill: ink }), /* @__PURE__ */ React.createElement("text", { x: "14", y: VB_H - 14, fontSize: "10", fontFamily: "ui-monospace, monospace", letterSpacing: "0.18em", fill: paper, stroke: "none" }, B.name.toUpperCase())));
  }
  function CabBrandTile({ theme, B, selected, onPick }) {
    const { ink, paper, accent, muted } = theme;
    const [hover, setHover] = useState(false);
    const lift = !selected && hover;
    return /* @__PURE__ */ React.createElement("button", { onClick: onPick, onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), style: {
      position: "relative",
      textAlign: "left",
      cursor: "pointer",
      background: selected ? paper : `${ink}03`,
      border: "none",
      borderTop: `3px solid ${selected ? accent : ink + "22"}`,
      padding: 0,
      transition: "all .25s",
      transform: lift ? "translateY(-3px)" : "none",
      boxShadow: selected ? `0 24px 60px ${ink}22, 0 0 0 0.5px ${ink}22` : lift ? `0 12px 32px ${ink}18, 0 0 0 0.5px ${ink}22` : `0 0 0 0.5px ${ink}11`
    } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1.1fr", height: 420 } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "36px 32px 32px", display: "flex", flexDirection: "column" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: selected ? accent : muted, marginBottom: 16 } }, /* @__PURE__ */ React.createElement("span", null, B.framingLabel)), /* @__PURE__ */ React.createElement("div", { style: { font: "300 64px/0.92 var(--font-heading)", color: ink, letterSpacing: "-0.02em" } }, B.name), /* @__PURE__ */ React.createElement("div", { style: { font: "400 13px/1 var(--font-heading)", color: muted, fontStyle: "italic", marginTop: 6 } }, B.tagline, " \xB7 ", B.origin), /* @__PURE__ */ React.createElement("p", { style: { font: "400 14px/1.55 var(--font-body)", color: `${ink}dd`, margin: "20px 0 0", flex: 1 } }, B.pitch), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 18, paddingTop: 16, borderTop: `0.5px solid ${ink}11`, display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "400 24px/1 var(--font-heading)", color: ink } }, B.stat.v), /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.14em", color: muted, marginTop: 4, textTransform: "uppercase" } }, B.stat.l)), /* @__PURE__ */ React.createElement("span", { style: { font: "500 11px/1 var(--font-body)", letterSpacing: "0.12em", textTransform: "uppercase", color: selected ? accent : ink } }, selected ? "Selected \u2713" : "Choose \u2192"))), /* @__PURE__ */ React.createElement("div", { style: { position: "relative", background: `${ink}05`, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: "20px 20px 20px 0" } }, /* @__PURE__ */ React.createElement(CabinetSpecimen, { theme, brand: B.id, door: B.defaults.door, finish: B.defaults.finish, hardware: B.defaults.hardware, softClose: true })))));
  }
  function CabHero({ theme, brand, setBrand }) {
    const { ink, paper, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("section", { style: { position: "relative", background: paper, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 18, padding: "16px 80px", borderBottom: `0.5px solid ${ink}11`, font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.22em", textTransform: "uppercase", color: muted, whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { style: { color: ink } }, "Roma \xB7 Cabinets"), /* @__PURE__ */ React.createElement("span", null, "\u2014"), /* @__PURE__ */ React.createElement("span", null, "Two lines, fully stocked"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, height: 1, background: `${ink}11` } }), /* @__PURE__ */ React.createElement("span", { style: { color: accent } }, "Designed in-house \xB7 Installed by our crew"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, height: 1, background: `${ink}11` } }), /* @__PURE__ */ React.createElement("span", null, "Anaheim, CA")), /* @__PURE__ */ React.createElement("div", { style: { padding: "72px 80px 88px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, font: "500 11px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted, marginBottom: 28 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 28, height: 1, background: accent } }), " 01 \xB7 Pick a philosophy"), /* @__PURE__ */ React.createElement("h1", { style: { font: "300 112px/0.92 var(--font-heading)", margin: 0, letterSpacing: "-0.025em", textWrap: "pretty", color: ink } }, "Cabinetry, ", /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, "two ways.")), /* @__PURE__ */ React.createElement("p", { style: { font: "400 20px/1.55 var(--font-body)", color: `${ink}dd`, margin: "32px 0 0", maxWidth: 760 } }, "Roma stocks both lines because most kitchens need a little of both. Choose American face-frame craftsmanship, or European frameless precision \u2014 both", /* @__PURE__ */ React.createElement("strong", { style: { color: ink, fontWeight: 500 } }, " sampled, specified, and installed "), "from one Anaheim showroom."), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 56, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 } }, Object.values(CAB_BRANDS).map((B) => /* @__PURE__ */ React.createElement(CabBrandTile, { key: B.id, theme, B, selected: brand === B.id, onPick: () => setBrand(B.id) })))));
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
    const usableLabel = framed ? "27\u2033" : "28\xBD\u2033";
    const doorOpenX = leftHinge.x, doorOpenY = leftHinge.y;
    const doorOpenTipY = doorOpenY + DOOR_LEN;
    const doorClosedTipX = leftHinge.x + DOOR_LEN;
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18, paddingBottom: 12, borderBottom: `0.5px solid ${ink}22` } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted, marginBottom: 6 } }, "Plan view \xB7 Section A-A \xB7 1 of 2"), /* @__PURE__ */ React.createElement("div", { style: { font: "400 32px/1 var(--font-heading)", color: ink, letterSpacing: "-0.01em" } }, framed ? "Face-frame" : "Frameless")), /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.14em", textTransform: "uppercase", color: accent } }, brand.name)), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 0 18px", gap: 24 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted, marginBottom: 10 } }, "Door opening"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 12 } }, /* @__PURE__ */ React.createElement("span", { style: { font: "300 64px/0.9 var(--font-heading)", color: ink, letterSpacing: "-0.02em" } }, usableLabel), /* @__PURE__ */ React.createElement("span", { style: { font: "400 14px/1 var(--font-body)", color: muted, fontStyle: "italic" } }, framed ? "usable, after frame" : "edge to edge"))), /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1.5 ui-monospace, monospace", letterSpacing: "0.14em", textTransform: "uppercase", color: framed ? muted : accent, textAlign: "right" } }, framed ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", null, "Lost to face frame"), /* @__PURE__ */ React.createElement("div", { style: { color: ink, fontSize: 18, fontFamily: "var(--font-heading), serif", textTransform: "none", letterSpacing: "0", marginTop: 6 } }, "\u2212", "3", "\u2033", " each cabinet")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", null, "Gained back"), /* @__PURE__ */ React.createElement("div", { style: { color: ink, fontSize: 18, fontFamily: "var(--font-heading), serif", textTransform: "none", letterSpacing: "0", marginTop: 6 } }, "+1", "\xBD\u2033", " each cabinet")))), /* @__PURE__ */ React.createElement("div", { style: { background: paper, border: `0.5px solid ${ink}22`, padding: "12px 18px 6px" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, style: { width: "100%", height: "auto", display: "block", overflow: "visible" } }, /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement("pattern", { id: `anat-hatch-${framed ? "fr" : "fl"}`, patternUnits: "userSpaceOnUse", width: "5", height: "5", patternTransform: "rotate(45)" }, /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "0", x2: "0", y2: "5", stroke: ink, strokeWidth: "0.6", strokeOpacity: "0.7" })), /* @__PURE__ */ React.createElement("pattern", { id: `anat-frame-${framed ? "fr" : "fl"}`, patternUnits: "userSpaceOnUse", width: "4", height: "4", patternTransform: "rotate(-45)" }, /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "0", x2: "0", y2: "4", stroke: ink, strokeWidth: "0.5", strokeOpacity: "0.55" }))), Array.from({ length: 13 }).map((_, i) => /* @__PURE__ */ React.createElement("line", { key: `gv${i}`, x1: 120 + i * 40, y1: 40, x2: 120 + i * 40, y2: 540, stroke: ink, strokeOpacity: "0.04", strokeWidth: "0.5" })), Array.from({ length: 12 }).map((_, i) => /* @__PURE__ */ React.createElement("line", { key: `gh${i}`, x1: 100, y1: 60 + i * 40, x2: 620, y2: 60 + i * 40, stroke: ink, strokeOpacity: "0.04", strokeWidth: "0.5" })), /* @__PURE__ */ React.createElement("g", { stroke: ink, strokeOpacity: "0.4", strokeWidth: "0.5", fill: ink, fillOpacity: "0.7" }, /* @__PURE__ */ React.createElement("line", { x1: CB_X0, y1: 36, x2: CB_X1, y2: 36 }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0, y1: 28, x2: CB_X0, y2: 44 }), /* @__PURE__ */ React.createElement("line", { x1: CB_X1, y1: 28, x2: CB_X1, y2: 44 }), /* @__PURE__ */ React.createElement("rect", { x: MID - 38, y: 26, width: "76", height: "20", fill: paper, stroke: "none" }), /* @__PURE__ */ React.createElement("text", { x: MID, y: 42, fontSize: "11", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", textAnchor: "middle", stroke: "none" }, "30", "\u2033", " EXTERIOR")), /* @__PURE__ */ React.createElement("rect", { x: CB_X0 + WALL, y: CB_Y0, width: CB_X1 - CB_X0 - 2 * WALL, height: CB_Y1 - CB_Y0, fill: `${ink}05` }), /* @__PURE__ */ React.createElement("rect", { x: CB_X0, y: CB_Y0, width: WALL, height: CB_Y1 - CB_Y0, fill: `url(#anat-hatch-${framed ? "fr" : "fl"})`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("rect", { x: CB_X1 - WALL, y: CB_Y0, width: WALL, height: CB_Y1 - CB_Y0, fill: `url(#anat-hatch-${framed ? "fr" : "fl"})`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("rect", { x: CB_X0, y: CB_Y0, width: CB_X1 - CB_X0, height: WALL, fill: `url(#anat-hatch-${framed ? "fr" : "fl"})`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + 2, y1: CB_Y0 + (CB_Y1 - CB_Y0) / 2, x2: CB_X1 - WALL - 2, y2: CB_Y0 + (CB_Y1 - CB_Y0) / 2, stroke: ink, strokeOpacity: "0.18", strokeWidth: "0.5", strokeDasharray: "4,3" }), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + WALL + 8, y: CB_Y0 + (CB_Y1 - CB_Y0) / 2 - 5, fontSize: "8", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.32", stroke: "none" }, "ADJ. SHELF"), framed && /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: CB_X0, y: frontY, width: WALL + FRAME_INWARD, height: FRAME_DEPTH + 4, fill: accent, fillOpacity: "0.18" }), /* @__PURE__ */ React.createElement("rect", { x: CB_X1 - WALL - FRAME_INWARD, y: frontY, width: WALL + FRAME_INWARD, height: FRAME_DEPTH + 4, fill: accent, fillOpacity: "0.18" }), /* @__PURE__ */ React.createElement("rect", { x: MID - FRAME_INWARD, y: frontY, width: 2 * FRAME_INWARD, height: FRAME_DEPTH + 4, fill: accent, fillOpacity: "0.18" }), /* @__PURE__ */ React.createElement("rect", { x: CB_X0, y: frontY, width: WALL + FRAME_INWARD, height: FRAME_DEPTH, fill: `url(#anat-frame-fr)`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("rect", { x: CB_X1 - WALL - FRAME_INWARD, y: frontY, width: WALL + FRAME_INWARD, height: FRAME_DEPTH, fill: `url(#anat-frame-fr)`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("rect", { x: MID - FRAME_INWARD, y: frontY, width: 2 * FRAME_INWARD, height: FRAME_DEPTH, fill: `url(#anat-frame-fr)`, stroke: ink, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + FRAME_INWARD, y1: frontY + 2, x2: MID - FRAME_INWARD, y2: frontY + 2, stroke: ink, strokeOpacity: "0.5", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + FRAME_INWARD, y1: frameFrontY - 2, x2: MID - FRAME_INWARD, y2: frameFrontY - 2, stroke: ink, strokeOpacity: "0.5", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: MID + FRAME_INWARD, y1: frontY + 2, x2: CB_X1 - WALL - FRAME_INWARD, y2: frontY + 2, stroke: ink, strokeOpacity: "0.5", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: MID + FRAME_INWARD, y1: frameFrontY - 2, x2: CB_X1 - WALL - FRAME_INWARD, y2: frameFrontY - 2, stroke: ink, strokeOpacity: "0.5", strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("g", { stroke: accent, strokeWidth: "1", fill: accent }, /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL - 4, y1: frontY + FRAME_DEPTH + 14, x2: CB_X0 + WALL + FRAME_INWARD + 2, y2: frontY + FRAME_DEPTH + 14 }), /* @__PURE__ */ React.createElement("polygon", { points: `${CB_X0 + WALL + FRAME_INWARD + 2},${frontY + FRAME_DEPTH + 14} ${CB_X0 + WALL + FRAME_INWARD - 6},${frontY + FRAME_DEPTH + 10} ${CB_X0 + WALL + FRAME_INWARD - 6},${frontY + FRAME_DEPTH + 18}` }))), /* @__PURE__ */ React.createElement("rect", { x: framed ? MID + FRAME_INWARD + 2 : MID + 2, y: framed ? frameFrontY : frontY, width: framed ? CB_X1 - WALL - FRAME_INWARD - MID - FRAME_INWARD - 2 : CB_X1 - WALL - MID - 2, height: DOOR_THK, fill: ink, fillOpacity: "0.86", stroke: ink, strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("path", { d: `M ${doorClosedTipX} ${doorOpenY} A ${DOOR_LEN} ${DOOR_LEN} 0 0 1 ${doorOpenX} ${doorOpenY + DOOR_LEN}`, fill: "none", stroke: accent, strokeWidth: "0.8", strokeDasharray: "4,4", strokeOpacity: "0.5" }), /* @__PURE__ */ React.createElement("rect", { x: doorOpenX, y: doorOpenY, width: DOOR_LEN, height: DOOR_THK, fill: "none", stroke: ink, strokeWidth: "0.5", strokeDasharray: "3,3", strokeOpacity: "0.3" }), /* @__PURE__ */ React.createElement("rect", { x: doorOpenX, y: doorOpenY, width: DOOR_THK, height: DOOR_LEN, fill: ink, fillOpacity: "0.86", stroke: ink, strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("line", { x1: doorOpenX + DOOR_THK / 2, y1: doorOpenY + 6, x2: doorOpenX + DOOR_THK / 2, y2: doorOpenY + DOOR_LEN - 6, stroke: paper, strokeOpacity: "0.15", strokeWidth: "0.5" }), framed ? /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: doorOpenX - 6, y: doorOpenY + 12, width: 6, height: 14, fill: accent, stroke: ink, strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("rect", { x: doorOpenX - 6, y: doorOpenY + DOOR_LEN - 26, width: 6, height: 14, fill: accent, stroke: ink, strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX, cy: doorOpenY + 19, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX, cy: doorOpenY + DOOR_LEN - 19, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("rect", { x: CB_X1 - WALL - FRAME_INWARD - 4, y: frameFrontY + DOOR_THK / 2 - 7, width: 8, height: 14, fill: accent, stroke: ink, strokeWidth: "0.5" })) : /* @__PURE__ */ React.createElement("g", null, [CB_Y0 + 32, CB_Y1 - 56].map((cy, i) => /* @__PURE__ */ React.createElement("g", { key: `lh${i}` }, /* @__PURE__ */ React.createElement("rect", { x: CB_X0 + WALL, y: cy - 4, width: 22, height: 28, fill: paper, stroke: ink, strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + 4, y1: cy, x2: CB_X0 + WALL + 18, y2: cy, stroke: ink, strokeOpacity: "0.35", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + 4, y1: cy + 20, x2: CB_X0 + WALL + 18, y2: cy + 20, stroke: ink, strokeOpacity: "0.35", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("path", { d: `M ${CB_X0 + WALL + 22} ${cy + 10} L ${CB_X0 + WALL + 32} ${cy + 10} L ${doorOpenX + DOOR_THK / 2} ${doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18)}`, fill: "none", stroke: accent, strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX + DOOR_THK / 2, cy: doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18), r: "5", fill: paper, stroke: accent, strokeWidth: "1.2" }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX + DOOR_THK / 2, cy: doorOpenY + (i === 0 ? 18 : DOOR_LEN - 18), r: "2", fill: accent }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X0 + WALL + 7, cy: cy + 6, r: "1.4", fill: ink, fillOpacity: "0.5" }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X0 + WALL + 7, cy: cy + 18, r: "1.4", fill: ink, fillOpacity: "0.5" }))), [CB_Y0 + 32, CB_Y1 - 56].map((cy, i) => /* @__PURE__ */ React.createElement("g", { key: `rh${i}` }, /* @__PURE__ */ React.createElement("rect", { x: CB_X1 - WALL - 22, y: cy - 4, width: 22, height: 28, fill: paper, stroke: ink, strokeWidth: "0.7" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X1 - WALL - 18, y1: cy, x2: CB_X1 - WALL - 4, y2: cy, stroke: ink, strokeOpacity: "0.35", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: CB_X1 - WALL - 18, y1: cy + 20, x2: CB_X1 - WALL - 4, y2: cy + 20, stroke: ink, strokeOpacity: "0.35", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X1 - WALL - 7, cy: cy + 6, r: "1.4", fill: ink, fillOpacity: "0.5" }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X1 - WALL - 7, cy: cy + 18, r: "1.4", fill: ink, fillOpacity: "0.5" })))), framed ? /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + FRAME_INWARD / 2, y1: frontY + FRAME_DEPTH / 2, x2: CB_X0 + 4, y2: frontY + 60, stroke: ink, strokeOpacity: "0.55", strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X0 + WALL + FRAME_INWARD / 2, cy: frontY + FRAME_DEPTH / 2, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + 4, y: frontY + 76, fontSize: "12", fontFamily: "ui-monospace, monospace", letterSpacing: "0.16em", fill: ink, fillOpacity: "0.8", textAnchor: "start", stroke: "none" }, "1", "\xBD\u2033", " FRAME"), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + 4, y: frontY + 92, fontSize: "10", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "start", stroke: "none" }, "maple stile"), /* @__PURE__ */ React.createElement("line", { x1: doorOpenX - 3, y1: doorOpenY + 19, x2: CB_X1 - 4, y2: frontY + 70, stroke: ink, strokeOpacity: "0.55", strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX - 3, cy: doorOpenY + 19, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - 4, y: frontY + 86, fontSize: "12", fontFamily: "ui-monospace, monospace", letterSpacing: "0.16em", fill: ink, fillOpacity: "0.8", textAnchor: "end", stroke: "none" }, "BUTT HINGE"), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - 4, y: frontY + 102, fontSize: "10", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "end", stroke: "none" }, "mortised")) : /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("line", { x1: CB_X0 + WALL + 11, y1: CB_Y0 + 42, x2: CB_X0 + 4, y2: CB_Y0 + 8, stroke: ink, strokeOpacity: "0.55", strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("circle", { cx: CB_X0 + WALL + 11, cy: CB_Y0 + 42, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + 4, y: CB_Y0 - 6, fontSize: "12", fontFamily: "ui-monospace, monospace", letterSpacing: "0.16em", fill: ink, fillOpacity: "0.8", textAnchor: "start", stroke: "none" }, "35mm CUP"), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + 4, y: CB_Y0 + 10, fontSize: "10", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "start", stroke: "none" }, "3-way adj."), /* @__PURE__ */ React.createElement("line", { x1: doorOpenX + DOOR_THK / 2, y1: doorOpenY + DOOR_LEN / 2, x2: CB_X1 - 4, y2: frontY + 90, stroke: ink, strokeOpacity: "0.55", strokeWidth: "0.6" }), /* @__PURE__ */ React.createElement("circle", { cx: doorOpenX + DOOR_THK / 2, cy: doorOpenY + DOOR_LEN / 2, r: "2", fill: ink }), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - 4, y: frontY + 106, fontSize: "12", fontFamily: "ui-monospace, monospace", letterSpacing: "0.16em", fill: ink, fillOpacity: "0.8", textAnchor: "end", stroke: "none" }, "FULL OVERLAY"), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - 4, y: frontY + 122, fontSize: "10", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "end", stroke: "none" }, "19mm slab")), /* @__PURE__ */ React.createElement("text", { x: CB_X0 + WALL / 2, y: CB_Y0 + (CB_Y1 - CB_Y0) / 2 + 3, fontSize: "8", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "middle", stroke: "none", transform: `rotate(-90, ${CB_X0 + WALL / 2}, ${CB_Y0 + (CB_Y1 - CB_Y0) / 2})` }, "\xBE\u2033", " PLY"), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - WALL / 2, y: CB_Y0 + (CB_Y1 - CB_Y0) / 2 + 3, fontSize: "8", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.55", textAnchor: "middle", stroke: "none", transform: `rotate(-90, ${CB_X1 - WALL / 2}, ${CB_Y0 + (CB_Y1 - CB_Y0) / 2})` }, "\xBE\u2033", " PLY"), /* @__PURE__ */ React.createElement("text", { x: doorOpenX + DOOR_THK + 6, y: doorOpenY + DOOR_LEN + 14, fontSize: "9", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.5", stroke: "none" }, "DOOR \xB7 90\xB0 OPEN"), /* @__PURE__ */ React.createElement("text", { x: CB_X1 - 6, y: (framed ? frameFrontY : frontY) - 4, fontSize: "9", fontFamily: "ui-monospace, monospace", letterSpacing: "0.14em", fill: ink, fillOpacity: "0.5", textAnchor: "end", stroke: "none" }, "DOOR \xB7 CLOSED"), /* @__PURE__ */ React.createElement("g", { stroke: accent, strokeWidth: "1.4", fill: accent }, /* @__PURE__ */ React.createElement("line", { x1: openingStart, y1: 500, x2: openingEnd, y2: 500 }), /* @__PURE__ */ React.createElement("polygon", { points: `${openingStart},${500} ${openingStart + 12},${493} ${openingStart + 12},${507}` }), /* @__PURE__ */ React.createElement("polygon", { points: `${openingEnd},${500} ${openingEnd - 12},${493} ${openingEnd - 12},${507}` }), /* @__PURE__ */ React.createElement("line", { x1: openingStart, y1: 488, x2: openingStart, y2: 512 }), /* @__PURE__ */ React.createElement("line", { x1: openingEnd, y1: 488, x2: openingEnd, y2: 512 })), /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: MID - 80, y: 488, width: "160", height: "24", fill: paper, stroke: "none" }), /* @__PURE__ */ React.createElement("text", { x: MID, y: 508, textAnchor: "middle", fontSize: "22", fontWeight: "400", fontFamily: "var(--font-heading), serif", fill: ink, stroke: "none" }, usableLabel)), /* @__PURE__ */ React.createElement("text", { x: MID, y: 530, textAnchor: "middle", fontSize: "11", fontFamily: "ui-monospace, monospace", letterSpacing: "0.18em", fill: accent, stroke: "none" }, framed ? "\u2014 30\u2033 EXT \u2212 1\xBD\u2033 WALLS \u2212 1\xBD\u2033 FRAME \u2014" : "\u2014 30\u2033 EXT \u2212 1\xBD\u2033 WALLS \u2014"), /* @__PURE__ */ React.createElement("g", { fill: ink, fillOpacity: "0.5", fontFamily: "ui-monospace, monospace", fontSize: "9", letterSpacing: "0.16em" }, /* @__PURE__ */ React.createElement("line", { x1: CB_X0, y1: 552, x2: CB_X1, y2: 552, stroke: ink, strokeOpacity: "0.15", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("text", { x: CB_X0, y: 570, stroke: "none" }, "SCALE 1:8 \xB7 SECTION A-A @ 17", "\u2033", " AFF"), /* @__PURE__ */ React.createElement("text", { x: CB_X1, y: 570, textAnchor: "end", stroke: "none" }, "B30 \xB7 30", "\u2033", " ", "\xD7", " 24", "\u2033", " ", "\xD7", " 34", "\xBD\u2033", " H")))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 22, display: "grid", gap: 10 } }, (framed ? [
      "Face frame keeps door alignment perfect for decades",
      "Traditional door styles (shaker, beaded, raised) need the frame to read correctly",
      "Field-repairable \u2014 broken butt hinge swaps in 10 min, no special tools",
      "Slight reveal between doors hides minor wood movement"
    ] : [
      "Zero face-frame intrusion \xB7 ~1\xBD\u2033 more usable opening per cabinet",
      "Doors flush with one another \u2014 no visible gaps, no shadow lines",
      "Concealed European cup hinge adjusts in three planes after install",
      "Required for handleless, integrated-channel, and push-to-open designs"
    ]).map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", gap: 12, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", background: accent, marginTop: 7, flexShrink: 0 } }), /* @__PURE__ */ React.createElement("span", { style: { font: "400 14px/1.45 var(--font-body)", color: `${ink}dd` } }, p)))));
  }
  function CabAnatomy({ theme }) {
    const { ink, paper, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", borderTop: `0.5px solid ${ink}11`, background: paper } }, /* @__PURE__ */ React.createElement(CabSectionHead, { theme, num: "02", eyebrow: "The Bones", headline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Framed, ", /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, "or frameless.")), sub: "The single decision that drives most of the others. Same finish, two very different ways of getting inside the box." }), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "start" } }, /* @__PURE__ */ React.createElement(CabAnatomyDiagram, { theme, framed: true, brand: CAB_BRANDS.waypoint }), /* @__PURE__ */ React.createElement(CabAnatomyDiagram, { theme, brand: CAB_BRANDS.europa })), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 56, padding: "36px 40px", background: ink, color: paper, position: "relative", overflow: "hidden", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 40, alignItems: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: -80, right: -40, width: 240, height: 240, borderRadius: "50%", background: `radial-gradient(circle at 30% 30%, ${accent}33, transparent 70%)` } }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.22em", textTransform: "uppercase", color: accent, marginBottom: 10 } }, "The delta"), /* @__PURE__ */ React.createElement("div", { style: { font: "300 36px/1.05 var(--font-heading)", color: paper, letterSpacing: "-0.01em", textWrap: "pretty" } }, "Over a 24-foot kitchen run, frameless gives you back ", /* @__PURE__ */ React.createElement("em", { style: { color: accent, fontStyle: "italic", fontWeight: 400 } }, " 14 extra inches"), " of usable interior.")), [{ v: "1\xBD\u2033", l: "Per cabinet" }, { v: "14\u2033", l: "Over 24-ft run" }, { v: "~5\u201310%", l: "More interior" }].map((s, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { position: "relative", paddingLeft: 24, borderLeft: `0.5px solid ${paper}22` } }, /* @__PURE__ */ React.createElement("div", { style: { font: "300 42px/1 var(--font-heading)", color: paper } }, s.v), /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1.3 ui-monospace, monospace", letterSpacing: "0.16em", textTransform: "uppercase", color: `${paper}88`, marginTop: 8 } }, s.l)))));
  }
  function CabConfigGroup({ theme, label, children }) {
    const { ink, muted } = theme;
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted, marginBottom: 12, paddingBottom: 8, borderBottom: `0.5px solid ${ink}11` } }, label), children);
  }
  function CabSegRow({ theme, value, onChange, options }) {
    const { ink, paper, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: `repeat(${options.length}, 1fr)`, gap: 0, border: `0.5px solid ${ink}22` } }, options.map((o, i) => {
      const active = value === o.id;
      return /* @__PURE__ */ React.createElement("button", { key: o.id, onClick: () => onChange(o.id), style: {
        padding: "12px 14px",
        cursor: "pointer",
        background: active ? ink : "transparent",
        color: active ? paper : ink,
        border: "none",
        borderLeft: i === 0 ? "none" : `0.5px solid ${ink}22`,
        font: "500 11px/1 var(--font-body)",
        letterSpacing: "0.06em",
        transition: "background .15s, color .15s"
      } }, o.label);
    }));
  }
  function CabMiniDoor({ theme, d, brand, finish }) {
    const B = CAB_BRANDS[brand];
    const F = B.finishes.find((f) => f.id === finish) || B.finishes[0];
    return /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 60 64", style: { width: "100%", height: "100%", display: "block" } }, /* @__PURE__ */ React.createElement("defs", null, F.wood && /* @__PURE__ */ React.createElement("pattern", { id: `mini-wood-${brand}-${F.id}`, patternUnits: "userSpaceOnUse", width: "60", height: "10", patternTransform: "rotate(90)" }, /* @__PURE__ */ React.createElement("rect", { width: "60", height: "10", fill: F.tone.a }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "3", width: "60", height: "0.6", fill: F.tone.c, opacity: "0.45" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "7", width: "60", height: "0.5", fill: F.tone.c, opacity: "0.3" }), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: "0.5", height: "10", fill: F.tone.c, opacity: "0.35" }), /* @__PURE__ */ React.createElement("rect", { x: "29", y: "0", width: "0.5", height: "10", fill: F.tone.c, opacity: "0.28" })), /* @__PURE__ */ React.createElement("linearGradient", { id: "mini-gloss", x1: "0", y1: "0", x2: "1", y2: "1" }, /* @__PURE__ */ React.createElement("stop", { offset: "0%", stopColor: "rgba(255,255,255,0.5)" }), /* @__PURE__ */ React.createElement("stop", { offset: "50%", stopColor: "rgba(255,255,255,0)" }), /* @__PURE__ */ React.createElement("stop", { offset: "100%", stopColor: "rgba(0,0,0,0.2)" }))), /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: "60", height: "64", fill: F.wood ? `url(#mini-wood-${brand}-${F.id})` : F.fill }), F.family === "gloss" && /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: "60", height: "64", fill: "url(#mini-gloss)" }), d.profile === "shaker" && /* @__PURE__ */ React.createElement("rect", { x: "8", y: "8", width: "44", height: "48", fill: "rgba(0,0,0,0.06)", stroke: "rgba(0,0,0,0.18)", strokeWidth: "0.4" }), d.profile === "recessed" && /* @__PURE__ */ React.createElement("rect", { x: "6", y: "6", width: "48", height: "52", fill: "rgba(0,0,0,0.06)", stroke: "rgba(0,0,0,0.18)", strokeWidth: "0.4" }), d.profile === "raised" && (() => {
      const ix0 = 8, iy0 = 8, ix1 = 52, iy1 = 56, ch = 4;
      return /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("polygon", { points: `${ix0 + ch},${iy0 + ch} ${ix1 - ch},${iy0 + ch} ${ix1 - ch},${iy1 - ch} ${ix0 + ch},${iy1 - ch}`, fill: "rgba(255,255,255,0.2)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix0},${iy0} ${ix1},${iy0} ${ix1 - ch},${iy0 + ch} ${ix0 + ch},${iy0 + ch}`, fill: "rgba(255,255,255,0.18)" }), /* @__PURE__ */ React.createElement("polygon", { points: `${ix0},${iy1} ${ix1},${iy1} ${ix1 - ch},${iy1 - ch} ${ix0 + ch},${iy1 - ch}`, fill: "rgba(0,0,0,0.16)" }));
    })(), d.profile === "beaded" && /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: "6", y: "6", width: "48", height: "52", fill: "rgba(0,0,0,0.04)" }), /* @__PURE__ */ React.createElement("rect", { x: "9", y: "9", width: "42", height: "46", fill: "none", stroke: "rgba(0,0,0,0.22)", strokeWidth: "0.4" })), d.profile === "arched" && /* @__PURE__ */ React.createElement("path", { d: "M 8 56 L 8 18 Q 8 8 30 8 Q 52 8 52 18 L 52 56 Z", fill: "rgba(0,0,0,0.05)", stroke: "rgba(0,0,0,0.2)", strokeWidth: "0.4" }), d.profile === "mullion" && /* @__PURE__ */ React.createElement("g", { stroke: "rgba(0,0,0,0.28)", strokeWidth: "0.4", fill: "rgba(255,255,255,0.1)" }, /* @__PURE__ */ React.createElement("rect", { x: "8", y: "8", width: "44", height: "48" }), /* @__PURE__ */ React.createElement("line", { x1: "8", y1: "32", x2: "52", y2: "32" }), /* @__PURE__ */ React.createElement("line", { x1: "30", y1: "8", x2: "30", y2: "56" })), d.profile === "channel" && /* @__PURE__ */ React.createElement("rect", { x: "0", y: "0", width: "60", height: "6", fill: "rgba(0,0,0,0.4)" }), d.profile === "slim" && /* @__PURE__ */ React.createElement("rect", { x: "4", y: "4", width: "52", height: "56", fill: "none", stroke: "rgba(0,0,0,0.2)", strokeWidth: "0.3" }), d.profile === "reeded" && /* @__PURE__ */ React.createElement("g", { stroke: "rgba(0,0,0,0.22)", strokeWidth: "0.5" }, Array.from({ length: 9 }).map((_, i) => /* @__PURE__ */ React.createElement("line", { key: i, x1: 4 + i * 6.5, y1: "0", x2: 4 + i * 6.5, y2: "64" }))), d.profile === "glass" && /* @__PURE__ */ React.createElement("g", null, /* @__PURE__ */ React.createElement("rect", { x: "6", y: "6", width: "48", height: "52", fill: "rgba(255,255,255,0.25)", stroke: "rgba(0,0,0,0.25)", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: "30", y1: "6", x2: "30", y2: "58", stroke: "rgba(0,0,0,0.25)", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "32", x2: "54", y2: "32", stroke: "rgba(0,0,0,0.25)", strokeWidth: "0.5" }), /* @__PURE__ */ React.createElement("line", { x1: "10", y1: "10", x2: "22", y2: "22", stroke: "rgba(255,255,255,0.6)", strokeWidth: "0.6" })));
  }
  function CabDoorChoice({ theme, d, brand, finish, active, onPick }) {
    const { ink, paper, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("button", { onClick: onPick, style: { position: "relative", cursor: "pointer", padding: 0, background: paper, border: `0.5px solid ${active ? accent : ink + "22"}`, boxShadow: active ? `0 0 0 1px ${accent}` : "none", display: "grid", gridTemplateColumns: "60px 1fr", alignItems: "stretch", textAlign: "left", transition: "border-color .15s, box-shadow .15s" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 64, overflow: "hidden" } }, /* @__PURE__ */ React.createElement(CabMiniDoor, { theme, d, brand, finish })), /* @__PURE__ */ React.createElement("div", { style: { padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "400 14px/1.1 var(--font-heading)", color: ink, letterSpacing: "-0.005em" } }, d.name), /* @__PURE__ */ React.createElement("div", { style: { font: "500 9px/1 ui-monospace, monospace", letterSpacing: "0.14em", textTransform: "uppercase", color: muted, marginTop: 3 } }, d.profile, d.sheen ? ` \xB7 ${d.sheen}` : "")));
  }
  function CabFinishSwatch({ theme, f, active, onPick }) {
    const { ink, paper, accent } = theme;
    const dark = (() => {
      const hex = (f.fill || "#888").replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return r * 0.299 + g * 0.587 + b * 0.114 < 130;
    })();
    const overlayText = dark ? paper : ink;
    return /* @__PURE__ */ React.createElement("button", { onClick: onPick, style: { position: "relative", cursor: "pointer", padding: 0, height: 78, border: "none", background: "transparent" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, overflow: "hidden", boxShadow: active ? `0 0 0 2px ${accent}, 0 8px 18px ${ink}33` : `0 0 0 0.5px ${ink}22`, transition: "box-shadow .15s" } }, f.wood ? /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, ...materialFace("wood", f.tone) } }) : /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: f.fill } }), f.family === "gloss" && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: "linear-gradient(135deg, rgba(255,255,255,0.5) 0%, transparent 40%, transparent 60%, rgba(0,0,0,0.22) 100%)" } }), f.family === "textured" && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgba(0,0,0,0.18) 1px, transparent 1.4px)", backgroundSize: "5px 5px", mixBlendMode: "overlay" } })), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", left: 6, top: 6, right: 6, font: "500 8px/1.1 ui-monospace, monospace", letterSpacing: "0.1em", color: overlayText, textTransform: "uppercase", opacity: 0.85, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: f.name }, f.name), active && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", right: 6, bottom: 6, width: 18, height: 18, borderRadius: "50%", background: accent, color: paper, display: "flex", alignItems: "center", justifyContent: "center", font: "500 11px/1 var(--font-body)" } }, "\u2713"));
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
      const validDoor = B.doors.some((d) => d.id === door);
      const validFinish = B.finishes.some((f) => f.id === finish);
      const validHw = B.hardware.some((h) => h.id === hardware);
      if (!validDoor) setDoor(B.defaults.door);
      if (!validFinish) setFinish(B.defaults.finish);
      if (!validHw) setHardware(B.defaults.hardware);
    }, [brand]);
    const F = B.finishes.find((f) => f.id === finish) || B.finishes[0];
    const D = B.doors.find((d) => d.id === door) || B.doors[0];
    const H = B.hardware.find((h) => h.id === hardware) || B.hardware[0];
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", background: `${ink}05`, borderTop: `0.5px solid ${ink}11` } }, /* @__PURE__ */ React.createElement(CabSectionHead, { theme, num: "03", eyebrow: "Build a sample", headline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Configure a base unit. ", /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, "See it live.")), sub: "Every choice updates the specimen. Brand, door, finish, hardware, and inserts \u2014 the same set of decisions you'll make in the showroom, surfaced up front." }), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 56, alignItems: "start" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { background: paper, padding: 24, border: `0.5px solid ${ink}11`, position: "relative" } }, /* @__PURE__ */ React.createElement(CabinetSpecimen, { theme, brand, door, finish, hardware, softClose, big: true })), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16, padding: "18px 20px", background: paper, border: `0.5px solid ${ink}11`, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 0 } }, [
      { l: "Unit", v: 'B36 \u2014 36" Base', mono: true },
      { l: "Door", v: D.name },
      { l: "Finish", v: F.name },
      { l: "Hardware", v: H.name },
      { l: "SKU", v: `${B.name.slice(0, 2).toUpperCase()}-${door.slice(0, 2).toUpperCase()}-${finish.slice(0, 2).toUpperCase()}-${hardware.slice(0, 2).toUpperCase()}`.toUpperCase(), mono: true }
    ].map((it, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { paddingLeft: i === 0 ? 0 : 18, borderLeft: i === 0 ? "none" : `0.5px solid ${ink}11` } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 9px/1 ui-monospace, monospace", letterSpacing: "0.18em", textTransform: "uppercase", color: muted, marginBottom: 6 } }, it.l), /* @__PURE__ */ React.createElement("div", { style: { font: it.mono ? "500 12px/1.2 ui-monospace, monospace" : "400 15px/1.2 var(--font-heading)", color: ink, letterSpacing: it.mono ? "0.08em" : "-0.005em" } }, it.v))))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 32 } }, /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: "Brand" }, /* @__PURE__ */ React.createElement(CabSegRow, { theme, value: brand, onChange: setBrand, options: [{ id: "waypoint", label: "Waypoint" }, { id: "europa", label: "Europa" }] })), /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: `Door style \xB7 ${B.doors.length}` }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 } }, B.doors.map((d) => /* @__PURE__ */ React.createElement(CabDoorChoice, { key: d.id, theme, d, brand, finish, active: door === d.id, onPick: () => setDoor(d.id) })))), /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: `Finish \xB7 ${B.finishes.length} colors` }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, maxHeight: 280, overflowY: "auto", paddingRight: 4 } }, B.finishes.map((f) => /* @__PURE__ */ React.createElement(CabFinishSwatch, { key: f.id, theme, f, active: finish === f.id, onPick: () => setFinish(f.id) })))), /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: "Hardware" }, /* @__PURE__ */ React.createElement(CabSegRow, { theme, value: hardware, onChange: setHardware, options: B.hardware.map((h) => ({ id: h.id, label: h.name })) })), /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: "Performance" }, /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 12, cursor: "pointer", padding: "12px 14px", border: `0.5px solid ${ink}22`, background: softClose ? `${accent}11` : "transparent" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 36, height: 20, borderRadius: 10, background: softClose ? accent : `${ink}22`, position: "relative", transition: "background .2s", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("span", { style: { position: "absolute", top: 2, left: softClose ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: paper, transition: "left .2s" } })), /* @__PURE__ */ React.createElement("span", { style: { flex: 1, font: "400 14px/1.3 var(--font-body)", color: ink } }, "Soft-close hinges & drawer slides"), /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: softClose, onChange: (e) => setSoftClose(e.target.checked), style: { display: "none" } }))), /* @__PURE__ */ React.createElement(CabConfigGroup, { theme, label: "Add interior fittings" }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } }, [
      { id: "trash", l: "Pull-out trash bin", d: "Twin 35-qt bins, blumotion close." },
      { id: "spice", l: "Spice rack pull-out", d: '4" wide vertical filler unit.' },
      { id: "lazy", l: "Lazy susan corner", d: "Two-tier 360\xB0 rotating shelves." },
      { id: "divider", l: "Drawer organizer", d: "Walnut grid, custom-cut to fit." }
    ].map((it) => /* @__PURE__ */ React.createElement("button", { key: it.id, onClick: () => setInserts((p) => ({ ...p, [it.id]: !p[it.id] })), style: { textAlign: "left", cursor: "pointer", padding: "12px 14px", border: `0.5px solid ${ink}22`, background: inserts[it.id] ? `${accent}11` : "transparent", borderColor: inserts[it.id] ? accent : `${ink}22` } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 14, height: 14, border: `1.5px solid ${inserts[it.id] ? accent : ink + "55"}`, background: inserts[it.id] ? accent : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center" } }, inserts[it.id] && /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "none", stroke: theme.paper, strokeWidth: "3" }, /* @__PURE__ */ React.createElement("path", { d: "M5 12l5 5 9-11" }))), /* @__PURE__ */ React.createElement("span", { style: { font: "500 12px/1.2 var(--font-body)", color: ink } }, it.l)), /* @__PURE__ */ React.createElement("div", { style: { font: "400 11px/1.4 var(--font-body)", color: muted, paddingLeft: 22 } }, it.d))))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 4, padding: "20px 22px", background: ink, color: paper, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.18em", textTransform: "uppercase", color: accent, marginBottom: 6 } }, "Estimated \xB7 ", B.lead), /* @__PURE__ */ React.createElement("div", { style: { font: "300 28px/1 var(--font-heading)", color: paper, whiteSpace: "nowrap" } }, "from ", B.startingAt)), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, flexShrink: 0 } }, /* @__PURE__ */ React.createElement("button", { style: { ...cabBtn(accent, paper, "primary", theme), padding: "11px 16px", fontSize: 11 } }, "Order sample"), /* @__PURE__ */ React.createElement("button", { style: { ...cabBtn(paper, ink, "primary", theme), background: "transparent", color: paper, border: `0.5px solid ${paper}55`, padding: "11px 16px", fontSize: 11 } }, "Wishlist"))))));
  }
  function CabFeatureIcon({ theme, kind }) {
    const { ink, accent } = theme;
    const W = 240, H = 180, cab = ink, mover = accent;
    switch (kind) {
      case "trash":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "20", width: "200", height: "140", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "40", x2: "220", y2: "40", stroke: cab, strokeWidth: "1", strokeOpacity: "0.3" }), /* @__PURE__ */ React.createElement("rect", { x: "40", y: "60", width: "60", height: "80", fill: "none", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "40", y1: "70", x2: "100", y2: "70", stroke: mover, strokeWidth: "1.2" }), /* @__PURE__ */ React.createElement("rect", { x: "120", y: "60", width: "60", height: "80", fill: "none", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "120", y1: "70", x2: "180", y2: "70", stroke: mover, strokeWidth: "1.2" }));
      case "lazy":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("path", { d: "M 20 30 L 20 160 L 220 160 L 220 30 L 130 30 L 100 30 Z", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "115", cy: "100", r: "62", fill: "none", stroke: mover, strokeWidth: "1.5", strokeDasharray: "3,3" }), /* @__PURE__ */ React.createElement("circle", { cx: "115", cy: "100", r: "40", fill: "none", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "115", y1: "100", x2: "175", y2: "60", stroke: mover, strokeWidth: "1.2" }), /* @__PURE__ */ React.createElement("line", { x1: "115", y1: "100", x2: "60", y2: "80", stroke: mover, strokeWidth: "1.2" }));
      case "spice":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "60", y: "20", width: "120", height: "140", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("rect", { x: "100", y: "30", width: "40", height: "120", fill: "none", stroke: mover, strokeWidth: "1.5" }), [50, 70, 90, 110, 130].map((y) => /* @__PURE__ */ React.createElement("g", { key: y }, /* @__PURE__ */ React.createElement("line", { x1: "100", y1: y, x2: "140", y2: y, stroke: mover, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "104", y: y + 3, width: "8", height: "12", fill: mover, fillOpacity: "0.5" }), /* @__PURE__ */ React.createElement("rect", { x: "116", y: y + 3, width: "8", height: "12", fill: mover, fillOpacity: "0.5" }), /* @__PURE__ */ React.createElement("rect", { x: "128", y: y + 3, width: "8", height: "12", fill: mover, fillOpacity: "0.5" }))));
      case "rollout":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "20", width: "200", height: "140", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "60", x2: "220", y2: "60", stroke: cab, strokeWidth: "1", strokeOpacity: "0.3" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "110", x2: "220", y2: "110", stroke: cab, strokeWidth: "1", strokeOpacity: "0.3" }), /* @__PURE__ */ React.createElement("rect", { x: "70", y: "68", width: "110", height: "34", fill: "none", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("rect", { x: "40", y: "118", width: "110", height: "34", fill: "none", stroke: mover, strokeWidth: "1.5" }));
      case "plate":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "20", width: "200", height: "140", fill: "none", stroke: cab, strokeWidth: "2" }), [40, 70, 100, 130, 160, 190].map((x) => /* @__PURE__ */ React.createElement("line", { key: x, x1: x, y1: "35", x2: x, y2: "145", stroke: mover, strokeWidth: "1.2" })), [55, 85, 115, 145, 175].map((x) => /* @__PURE__ */ React.createElement("circle", { key: x, cx: x, cy: "90", r: "14", fill: "none", stroke: mover, strokeWidth: "1", strokeOpacity: "0.7" })));
      case "divider":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "30", width: "200", height: "120", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "80", y1: "30", x2: "80", y2: "150", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "140", y1: "30", x2: "140", y2: "150", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "90", x2: "80", y2: "90", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "140", y1: "70", x2: "220", y2: "70", stroke: mover, strokeWidth: "1.5" }), /* @__PURE__ */ React.createElement("line", { x1: "140", y1: "110", x2: "220", y2: "110", stroke: mover, strokeWidth: "1.5" }));
      case "softclose":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "40", width: "100", height: "100", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "120", y1: "40", x2: "120", y2: "140", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("g", { transform: "translate(120 90)" }, /* @__PURE__ */ React.createElement("path", { d: "M 0 -28 A 38 38 0 0 1 38 0 A 38 38 0 0 1 0 28", stroke: mover, strokeWidth: "2", fill: "none", strokeDasharray: "4,4" }), /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "0", x2: "0", y2: "-28", stroke: mover, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "0", y1: "0", x2: "28", y2: "0", stroke: mover, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "0", cy: "0", r: "3", fill: mover })), /* @__PURE__ */ React.createElement("rect", { x: "160", y: "70", width: "40", height: "40", fill: mover, fillOpacity: "0.18", stroke: mover, strokeWidth: "1" }), /* @__PURE__ */ React.createElement("text", { x: "180", y: "96", textAnchor: "middle", fontSize: "14", fontFamily: "var(--font-heading), serif", fill: ink }, "S/C"));
      case "tipout":
        return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, style: { width: "100%", height: "100%" } }, /* @__PURE__ */ React.createElement("rect", { x: "20", y: "20", width: "200", height: "140", fill: "none", stroke: cab, strokeWidth: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "60", x2: "220", y2: "60", stroke: cab, strokeWidth: "1", strokeOpacity: "0.3" }), /* @__PURE__ */ React.createElement("g", { transform: "translate(120 60)" }, /* @__PURE__ */ React.createElement("rect", { x: "-80", y: "-20", width: "160", height: "22", fill: "none", stroke: mover, strokeWidth: "1.5", transform: "rotate(-22)" })), /* @__PURE__ */ React.createElement("rect", { x: "60", y: "78", width: "120", height: "14", fill: mover, fillOpacity: "0.5", stroke: mover, strokeWidth: "1" }));
      default:
        return null;
    }
  }
  function CabFeatures({ theme }) {
    const { ink, paper, accent, muted } = theme;
    const features = [
      { id: "trash", name: "Pull-out trash", blurb: "Twin 35-qt bins on full-extension slides.", icon: "trash" },
      { id: "lazy", name: "Lazy-susan corner", blurb: "Two-tier 360\xB0 rotating shelves.", icon: "lazy" },
      { id: "spice", name: "Spice pull-out", blurb: "4\u2033 filler unit, four tiered shelves.", icon: "spice" },
      { id: "rollout", name: "Roll-out tray", blurb: "Convert any door cabinet into a deep drawer.", icon: "rollout" },
      { id: "plate", name: "Plate rack divider", blurb: "Vertical slots for plates and cookware lids.", icon: "plate" },
      { id: "divider", name: "Drawer organizer", blurb: "Walnut grid, custom-cut to your drawer width.", icon: "divider" },
      { id: "softclose", name: "Soft-close hinges", blurb: "Cushioned closing, every door, every drawer.", icon: "softclose" },
      { id: "tipout", name: "Sink-front tip-out", blurb: "Sponge tray hidden behind a false-front panel.", icon: "tipout" }
    ];
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", background: paper, borderTop: `0.5px solid ${ink}11` } }, /* @__PURE__ */ React.createElement(CabSectionHead, { theme, num: "04", eyebrow: "Inside the box", headline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Storage that ", /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, "actually stores.")), sub: "Every Roma cabinet is sized to a 16\u2033 deep insert. Mix-and-match these on the configurator above." }), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 } }, features.map((f, i) => /* @__PURE__ */ React.createElement("div", { key: f.id, style: { position: "relative", background: `${ink}04`, border: `0.5px solid ${ink}11`, padding: 24, display: "grid", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.18em", textTransform: "uppercase", color: muted } }, /* @__PURE__ */ React.createElement("span", null, "F-", String(i + 1).padStart(2, "0")), /* @__PURE__ */ React.createElement("span", null, "Insert")), /* @__PURE__ */ React.createElement("div", { style: { height: 180, position: "relative" } }, /* @__PURE__ */ React.createElement(CabFeatureIcon, { theme, kind: f.icon })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "400 20px/1.15 var(--font-heading)", color: ink, letterSpacing: "-0.01em" } }, f.name), /* @__PURE__ */ React.createElement("div", { style: { font: "400 13px/1.45 var(--font-body)", color: `${ink}bb`, marginTop: 6 } }, f.blurb))))));
  }
  function CabFinishCard({ theme, f }) {
    const { ink, paper, accent, muted } = theme;
    const [hover, setHover] = useState(false);
    const dark = (() => {
      if (!f.fill) return false;
      const hex = f.fill.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return r * 0.299 + g * 0.587 + b * 0.114 < 130;
    })();
    const overlayText = dark ? paper : ink;
    return /* @__PURE__ */ React.createElement("div", { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), style: { position: "relative", height: 240, overflow: "hidden", background: paper, boxShadow: `0 0 0 0.5px ${ink}22, 0 ${hover ? 14 : 0}px ${hover ? 28 : 0}px ${ink}1a`, transition: "box-shadow .2s, transform .2s", transform: hover ? "translateY(-4px)" : "none" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 0, left: 0, right: 0, height: 164, overflow: "hidden" } }, f.wood ? /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, ...materialFace("wood", f.tone) } }) : /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: f.fill } }), f.family === "gloss" && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: "linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.1) 35%, transparent 60%, rgba(0,0,0,0.22) 100%)" } }), f.family === "textured" && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgba(0,0,0,0.18) 1px, transparent 1.4px), radial-gradient(rgba(255,255,255,0.15) 1px, transparent 1.4px)", backgroundSize: "6px 6px, 9px 9px", backgroundPosition: "0 0, 3px 3px", mixBlendMode: "overlay" } }), f.family === "matte" && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, boxShadow: "inset 0 0 60px rgba(0,0,0,0.08)" } }), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 10, left: 10, display: "flex", alignItems: "center", gap: 6, font: "500 9px/1 ui-monospace, monospace", letterSpacing: "0.14em", textTransform: "uppercase", color: overlayText, opacity: 0.85 } }, /* @__PURE__ */ React.createElement("span", { style: { padding: "3px 6px", border: `0.5px solid ${overlayText}55`, borderRadius: 2 } }, f.brand === "waypoint" ? "WP" : "EU"), /* @__PURE__ */ React.createElement("span", null, f.family, f.species ? ` \xB7 ${f.species}` : ""))), /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", bottom: 0, left: 0, right: 0, height: 76, padding: "14px 14px", background: paper, borderTop: `0.5px solid ${ink}11`, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }, title: f.name }, /* @__PURE__ */ React.createElement("div", { style: { font: "400 15px/1.15 var(--font-heading)", color: ink, letterSpacing: "-0.005em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.name), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, font: "500 9px/1 ui-monospace, monospace", letterSpacing: "0.1em", textTransform: "uppercase", color: muted } }, /* @__PURE__ */ React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.fill.toUpperCase()), /* @__PURE__ */ React.createElement("span", { style: { color: accent, whiteSpace: "nowrap", flexShrink: 0 } }, "\u2192"))));
  }
  function CabFinishes({ theme }) {
    const { ink, paper, accent, muted } = theme;
    const all = [...CAB_BRANDS.waypoint.finishes.map((f) => ({ ...f, brand: "waypoint" })), ...CAB_BRANDS.europa.finishes.map((f) => ({ ...f, brand: "europa" }))];
    const [filter, setFilter] = useState("all");
    const filters = [{ id: "all", l: "All" }, { id: "waypoint", l: "Waypoint" }, { id: "europa", l: "Europa" }, { id: "painted", l: "Painted" }, { id: "stained", l: "Stained" }, { id: "matte", l: "Matte" }, { id: "gloss", l: "Gloss" }, { id: "veneer", l: "Veneer" }, { id: "textured", l: "Textured" }];
    const shown = all.filter((f) => filter === "all" || filter === f.brand || filter === f.family);
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", background: `${ink}05`, borderTop: `0.5px solid ${ink}11` } }, /* @__PURE__ */ React.createElement(CabSectionHead, { theme, num: "05", eyebrow: "Finishes", headline: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, all.length), " ways to wear it."), sub: "Painted, stained, matte, gloss, real-wood veneer, textured concrete. All physically stocked in the showroom \u2014 request any as a 5\u2033 door sample, free." }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 28, alignItems: "baseline" } }, filters.map((ft) => {
      const active = filter === ft.id;
      const count = ft.id === "all" ? all.length : all.filter((f) => ft.id === f.brand || ft.id === f.family).length;
      return /* @__PURE__ */ React.createElement("button", { key: ft.id, onClick: () => setFilter(ft.id), style: { padding: "9px 14px", borderRadius: 999, cursor: "pointer", border: `0.5px solid ${active ? accent : ink + "22"}`, background: active ? accent : "transparent", color: active ? paper : ink, font: "500 11px/1 var(--font-body)", letterSpacing: "0.06em", display: "inline-flex", alignItems: "center", gap: 8, transition: "all .15s" } }, ft.l, /* @__PURE__ */ React.createElement("span", { style: { font: "500 9px/1 ui-monospace, monospace", letterSpacing: "0.08em", opacity: 0.6 } }, count));
    })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 } }, shown.map((f) => /* @__PURE__ */ React.createElement(CabFinishCard, { key: `${f.brand}-${f.id}`, theme, f }))));
  }
  function CabCompare({ theme, setBrand }) {
    const { ink, paper, accent, muted } = theme;
    const rows = [
      { label: "Construction", w: "Face-frame, \xBE\u2033 ply box", e: "Frameless, 19mm full-overlay" },
      { label: "Door styles", w: "6 styles: shaker, recessed, raised, beaded, arched, mullion", e: "6 styles: slab, channel, slim, gloss, reeded, glass" },
      { label: "Finishes", w: "25 total \xB7 12 paints \xB7 12 stains", e: "23 total \xB7 14 mattes \xB7 3 glosses \xB7 4 veneers \xB7 2 textured" },
      { label: "Drawer guides", w: "Blum Tandem full-extension", e: "Blum Legrabox full-extension" },
      { label: "Soft-close", w: "Standard, all doors & drawers", e: "Standard, push-to-open optional" },
      { label: "Hardware", w: "Knobs, bar pulls, cup pulls", e: "Integrated channel, slim bar, push-to-open" },
      { label: "Custom paint", w: "No (8 standard colors)", e: "Yes, any RAL or Pantone (+$45 /opening)" },
      { label: "Warranty", w: "Lifetime", e: "10-year" },
      { label: "Lead time", w: "5\u20137 weeks", e: "4\u20136 weeks" },
      { label: "Made in", w: "Cumberland, MD \xB7 USA", e: "Italian-engineered, assembled in Mexico" },
      { label: "Starting at", w: "$240 / lf", e: "$320 / lf" }
    ];
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", background: paper, borderTop: `0.5px solid ${ink}11` } }, /* @__PURE__ */ React.createElement(CabSectionHead, { theme, num: "06", eyebrow: "The fine print", headline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Side by side, ", /* @__PURE__ */ React.createElement("em", { style: { color: accent } }, "row by row.")), sub: "The spec sheet, exposed." }), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderTop: `0.5px solid ${ink}22` } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 0" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted } }, "Spec")), /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 24px", borderLeft: `0.5px solid ${ink}22` } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 10, font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: muted, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", background: ink } }), "Waypoint"), /* @__PURE__ */ React.createElement("div", { style: { font: "400 22px/1 var(--font-heading)", color: ink } }, "Face-frame")), /* @__PURE__ */ React.createElement("div", { style: { padding: "20px 24px", borderLeft: `0.5px solid ${ink}22`, background: `${accent}06` } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 10, font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.2em", textTransform: "uppercase", color: accent, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", background: accent } }), "Europa"), /* @__PURE__ */ React.createElement("div", { style: { font: "400 22px/1 var(--font-heading)", color: ink } }, "Frameless")), rows.map((r, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, /* @__PURE__ */ React.createElement("div", { style: { padding: "18px 0", borderTop: `0.5px solid ${ink}11`, font: "500 10px/1.2 ui-monospace, monospace", letterSpacing: "0.16em", textTransform: "uppercase", color: muted } }, r.label), /* @__PURE__ */ React.createElement("div", { style: { padding: "18px 24px", borderTop: `0.5px solid ${ink}11`, borderLeft: `0.5px solid ${ink}22`, font: "400 15px/1.4 var(--font-heading)", color: ink } }, r.w), /* @__PURE__ */ React.createElement("div", { style: { padding: "18px 24px", borderTop: `0.5px solid ${ink}11`, borderLeft: `0.5px solid ${ink}22`, font: "400 15px/1.4 var(--font-heading)", color: ink, background: `${accent}06` } }, r.e)))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 32, padding: "24px 28px", background: `${ink}05`, display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1 ui-monospace, monospace", letterSpacing: "0.18em", textTransform: "uppercase", color: muted, marginBottom: 6 } }, "Still deciding?"), /* @__PURE__ */ React.createElement("div", { style: { font: "400 22px/1.2 var(--font-heading)", color: ink } }, "Order a sample door from each. They're free, they arrive in a week.")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10 } }, /* @__PURE__ */ React.createElement("button", { onClick: () => setBrand("waypoint"), style: cabBtn(ink, paper, "primary", theme) }, "Waypoint sample"), /* @__PURE__ */ React.createElement("button", { onClick: () => setBrand("europa"), style: cabBtn(accent, paper, "primary", theme) }, "Europa sample"))));
  }
  function CabCTA({ theme }) {
    const { ink, paper, accent, muted } = theme;
    return /* @__PURE__ */ React.createElement("section", { style: { padding: "120px 80px", background: ink, color: paper, position: "relative", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: -160, right: -120, width: 520, height: 520, borderRadius: "50%", background: `radial-gradient(circle at 30% 30%, ${accent}38, transparent 70%)` } }), /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1 ui-monospace, monospace", letterSpacing: "0.22em", textTransform: "uppercase", color: accent, marginBottom: 24 } }, "07 \xB7 The showroom"), /* @__PURE__ */ React.createElement("h2", { style: { font: "300 84px/0.92 var(--font-heading)", margin: 0, letterSpacing: "-0.02em", color: paper, maxWidth: 1100 } }, "Touch the doors. ", /* @__PURE__ */ React.createElement("em", { style: { color: accent, fontStyle: "italic" } }, "Open the drawers."), /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("span", { style: { color: `${paper}aa`, fontStyle: "italic" } }, "Then build a kitchen.")), /* @__PURE__ */ React.createElement("p", { style: { font: "400 18px/1.55 var(--font-body)", color: `${paper}cc`, margin: "32px 0 0", maxWidth: 640 } }, "A full Waypoint and Europa wall lives in our Anaheim showroom \u2014 every door style, every finish, every hinge, ready to be opened, slammed shut, and judged in person. Bring a paint chip. Bring a cabinet maker. We'll meet you there."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 14, marginTop: 44, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("button", { style: cabBtn(accent, paper, "primary", theme) }, "Book a design consult"), /* @__PURE__ */ React.createElement("button", { style: { ...cabBtn(paper, ink, "primary", theme), background: "transparent", color: paper, border: `0.5px solid ${paper}55` } }, "Order sample doors"), /* @__PURE__ */ React.createElement("button", { style: { ...cabBtn(paper, ink, "primary", theme), background: "transparent", color: paper, border: `0.5px solid ${paper}55` } }, "Visit the showroom")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 64, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0, paddingTop: 32, borderTop: `0.5px solid ${paper}22` } }, [{ v: "Mon\u2013Sat", l: "9 am \u2013 6 pm" }, { v: "1440", l: "S. State College, Anaheim" }, { v: "(714) 999-0009", l: "Showroom direct" }, { v: "Free", l: "Sample door program" }].map((it, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { paddingLeft: i === 0 ? 0 : 24, borderLeft: i === 0 ? "none" : `0.5px solid ${paper}22` } }, /* @__PURE__ */ React.createElement("div", { style: { font: "400 22px/1.1 var(--font-heading)", color: paper } }, it.v), /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1.3 var(--font-body)", color: `${paper}88`, marginTop: 6 } }, it.l))))));
  }
  function CabinetsPage() {
    const [brand, setBrand] = useState("waypoint");
    const theme = { ink: "#1c1917", paper: "#ece5d8", accent: "#a87935", muted: "#8a7e6b" };
    useEffect(() => {
      updateSEO({ title: "Custom Cabinets | Roma Flooring Designs", description: "Waypoint face-frame and Europa frameless cabinetry \u2014 designed in-house, installed by our crew. Visit our Anaheim showroom.", url: SITE_URL + "/cabinets" });
    }, []);
    return /* @__PURE__ */ React.createElement("div", { className: "cab-page", style: { background: theme.paper, color: theme.ink, fontFamily: "var(--font-body)" } }, /* @__PURE__ */ React.createElement(CabHero, { theme, brand, setBrand }), /* @__PURE__ */ React.createElement(CabAnatomy, { theme }), /* @__PURE__ */ React.createElement(CabConfigurator, { theme, brand, setBrand }), /* @__PURE__ */ React.createElement(CabFeatures, { theme }), /* @__PURE__ */ React.createElement(CabFinishes, { theme }), /* @__PURE__ */ React.createElement(CabCompare, { theme, setBrand }), /* @__PURE__ */ React.createElement(CabCTA, { theme }));
  }
  document.addEventListener("error", function(e) {
    if (e.target.tagName === "IMG") e.target.style.display = "none";
  }, true);
  function StorefrontApp() {
    const [view, setView] = useState("home");
    const [selectedSkuId, setSelectedSkuId] = useState(null);
    const [skus, setSkus] = useState([]);
    const [totalSkus, setTotalSkus] = useState(0);
    const [categories, setCategories] = useState([]);
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [selectedCollection, setSelectedCollection] = useState(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchDidYouMean, setSearchDidYouMean] = useState(null);
    const [searchTimeMs, setSearchTimeMs] = useState(null);
    const [relatedSearches, setRelatedSearches] = useState([]);
    const [matchingCategories, setMatchingCategories] = useState([]);
    const [filters, setFilters] = useState({});
    const [facets, setFacets] = useState([]);
    const [vendorFacets, setVendorFacets] = useState([]);
    const [priceRange, setPriceRange] = useState({ min: 0, max: 1e3 });
    const [userPriceRange, setUserPriceRange] = useState({ min: null, max: null });
    const [vendorFilters, setVendorFilters] = useState([]);
    const [globalFacets, setGlobalFacets] = useState([]);
    const [tagFacets, setTagFacets] = useState([]);
    const [tagFilters, setTagFilters] = useState([]);
    const [sortBy, setSortBy] = useState("name_asc");
    const [loadingSkus, setLoadingSkus] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [featuredSkus, setFeaturedSkus] = useState([]);
    const [featuredLoading, setFeaturedLoading] = useState(true);
    const [cart, setCart] = useState([]);
    const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
    const [cartFlash, setCartFlash] = useState(false);
    const [deliveryMethod, setDeliveryMethod] = useState("shipping");
    const [liftgateEnabled, setLiftgateEnabled] = useState(true);
    const [appliedPromoCode, setAppliedPromoCode] = useState(null);
    const [quickViewSku, setQuickViewSku] = useState(null);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
    const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
    const [visitRecapToken, setVisitRecapToken] = useState(null);
    const [tradeCustomer, setTradeCustomer] = useState(null);
    const [tradeToken, setTradeToken] = useState(localStorage.getItem("trade_token") || null);
    const [customer, setCustomer] = useState(null);
    const [customerToken, setCustomerToken] = useState(localStorage.getItem("customer_token") || null);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [authModalMode, setAuthModalMode] = useState("login");
    const [showTradeModal, setShowTradeModal] = useState(false);
    const [tradeModalMode, setTradeModalMode] = useState("login");
    const [showInstallModal, setShowInstallModal] = useState(false);
    const [showFloorQuiz, setShowFloorQuiz] = useState(false);
    const [installModalProduct, setInstallModalProduct] = useState(null);
    const [completedOrder, setCompletedOrder] = useState(null);
    const [klarnaFinalizing, setKlarnaFinalizing] = useState(false);
    const [klarnaError, setKlarnaError] = useState("");
    const [toasts, setToasts] = useState([]);
    const toastIdRef = useRef(0);
    const toastTimersRef = useRef([]);
    const showToast = useCallback((message, type = "info", duration = 3500) => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
      const t1 = setTimeout(() => {
        setToasts((prev) => prev.map((t) => t.id === id ? { ...t, leaving: true } : t));
        const t2 = setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 350);
        toastTimersRef.current.push(t2);
      }, duration);
      toastTimersRef.current.push(t1);
    }, []);
    useEffect(() => () => {
      toastTimersRef.current.forEach((t) => clearTimeout(t));
    }, []);
    const [wishlist, setWishlist] = useState(() => {
      try {
        return JSON.parse(localStorage.getItem("wishlist") || "[]");
      } catch (e) {
        return [];
      }
    });
    const [recentlyViewed, setRecentlyViewed] = useState(() => {
      try {
        return JSON.parse(localStorage.getItem("recently_viewed") || "[]");
      } catch (e) {
        return [];
      }
    });
    const addRecentlyViewed = (skuData) => {
      setRecentlyViewed((prev) => {
        const filtered = prev.filter((s) => s.sku_id !== skuData.sku_id);
        const updated = [{ sku_id: skuData.sku_id, product_name: skuData.product_name, variant_name: skuData.variant_name, primary_image: skuData.primary_image, retail_price: skuData.retail_price, cut_price: skuData.cut_price, price_basis: skuData.price_basis, sell_by: skuData.sell_by, sqft_per_box: skuData.sqft_per_box }, ...filtered].slice(0, 12);
        try {
          localStorage.setItem("recently_viewed", JSON.stringify(updated));
        } catch (e) {
        }
        return updated;
      });
    };
    const sessionId = useRef(getSessionId());
    const scrollY = useRef(0);
    const pendingScroll = useRef(null);
    const analyticsAllowed = () => {
      try {
        return localStorage.getItem("cookie_consent") !== "declined";
      } catch (e) {
        return false;
      }
    };
    const getVisitorId = () => {
      try {
        let vid = localStorage.getItem("analytics_visitor_id");
        if (!vid) {
          vid = window.crypto && crypto.randomUUID ? crypto.randomUUID() : "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
          localStorage.setItem("analytics_visitor_id", vid);
        }
        return vid;
      } catch (e) {
        return null;
      }
    };
    const track = (event_type, properties) => {
      if (!analyticsAllowed()) return;
      try {
        fetch(API + "/api/analytics/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ events: [{
            event_type,
            properties: properties || {},
            session_id: sessionId.current,
            visitor_id: getVisitorId(),
            page_path: window.location.pathname,
            referrer: document.referrer || null
          }] })
        }).catch(() => {
        });
      } catch (e) {
      }
    };
    const pingSession = () => {
      if (!analyticsAllowed()) return;
      try {
        const sp = new URLSearchParams(window.location.search);
        const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
        fetch(API + "/api/analytics/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            session_id: sessionId.current,
            visitor_id: getVisitorId(),
            user_agent: navigator.userAgent,
            referrer: document.referrer || null,
            device_type: window.innerWidth < 768 ? "mobile" : isTouch && window.innerWidth < 1024 ? "tablet" : "desktop",
            utm_source: sp.get("utm_source"),
            utm_medium: sp.get("utm_medium"),
            utm_campaign: sp.get("utm_campaign")
          })
        }).catch(() => {
        });
      } catch (e) {
      }
    };
    useEffect(() => {
      pingSession();
    }, []);
    useEffect(() => {
      track("page_view", { view });
    }, [view]);
    const tradeHeaders = () => {
      const t = localStorage.getItem("trade_token");
      return t ? { "X-Trade-Token": t } : {};
    };
    const fetchSkusRef = useRef(null);
    const fetchFacetsRef = useRef(null);
    const fetchSkusAbort = useRef(null);
    const fetchFacetsAbort = useRef(null);
    const fetchSkus = useCallback((opts = {}) => {
      const PAGE_SIZE = 24;
      const { cat, coll, search, activeFilters, sort, page, vendors, priceMin, priceMax, tags } = {
        cat: selectedCategory,
        coll: selectedCollection,
        search: searchQuery,
        activeFilters: filters,
        sort: sortBy,
        page: currentPage,
        vendors: vendorFilters,
        priceMin: userPriceRange.min,
        priceMax: userPriceRange.max,
        tags: tagFilters,
        ...opts
      };
      const params = new URLSearchParams();
      if (cat) params.set("category", cat);
      if (coll) params.set("collection", coll);
      if (search) params.set("q", search);
      if (sort && sort !== "relevance") params.set("sort", sort);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const af = activeFilters || {};
      Object.keys(af).forEach((slug) => {
        if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join("|"));
      });
      const vf = vendors || [];
      if (vf.length > 0) params.set("brand", vf.join("|"));
      if (priceMin != null) params.set("price_min", String(priceMin));
      if (priceMax != null) params.set("price_max", String(priceMax));
      const tf = tags || [];
      if (tf.length > 0) params.set("tags", tf.join("|"));
      if (fetchSkusAbort.current) fetchSkusAbort.current.abort();
      const controller = new AbortController();
      fetchSkusAbort.current = controller;
      setLoadingSkus(true);
      fetch(API + "/api/storefront/skus?" + params.toString(), { headers: tradeHeaders(), signal: controller.signal }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
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
      }).catch((err) => {
        if (err.name !== "AbortError") {
          console.error(err);
          setLoadingSkus(false);
        }
      });
    }, [selectedCategory, selectedCollection, searchQuery, filters, sortBy, currentPage, vendorFilters, userPriceRange, tagFilters]);
    const fetchFacets = useCallback((opts = {}) => {
      const { cat, coll, search, activeFilters, vendors, priceMin, priceMax, tags } = {
        cat: selectedCategory,
        coll: selectedCollection,
        search: searchQuery,
        activeFilters: filters,
        vendors: vendorFilters,
        priceMin: userPriceRange.min,
        priceMax: userPriceRange.max,
        tags: tagFilters,
        ...opts
      };
      const params = new URLSearchParams();
      if (cat) params.set("category", cat);
      if (coll) params.set("collection", coll);
      if (search) params.set("q", search);
      const af = activeFilters || {};
      Object.keys(af).forEach((slug) => {
        if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join("|"));
      });
      const vf = vendors || [];
      if (vf.length > 0) params.set("brand", vf.join("|"));
      if (priceMin != null) params.set("price_min", String(priceMin));
      if (priceMax != null) params.set("price_max", String(priceMax));
      const tf = tags || [];
      if (tf.length > 0) params.set("tags", tf.join("|"));
      if (fetchFacetsAbort.current) fetchFacetsAbort.current.abort();
      const facetController = new AbortController();
      fetchFacetsAbort.current = facetController;
      fetch(API + "/api/storefront/facets?" + params.toString(), { signal: facetController.signal }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setFacets(data.facets || []);
        setVendorFacets(data.brands || data.vendors || []);
        setTagFacets(data.tags || []);
        if (data.priceRange) setPriceRange(data.priceRange);
      }).catch((err) => {
        if (err.name !== "AbortError") console.error(err);
      });
    }, [selectedCategory, selectedCollection, searchQuery, filters, vendorFilters, userPriceRange, tagFilters]);
    fetchSkusRef.current = fetchSkus;
    fetchFacetsRef.current = fetchFacets;
    const buildShopUrl = (cat, coll, search, af, vf, prMin, prMax, tf) => {
      const params = new URLSearchParams();
      if (cat) params.set("category", cat);
      if (coll) params.set("collection", coll);
      if (search) params.set("q", search);
      const f = af || {};
      Object.keys(f).forEach((slug) => {
        if (f[slug] && f[slug].length > 0) params.set(slug, f[slug].join("|"));
      });
      if (vf && vf.length > 0) params.set("vendor", vf.join("|"));
      if (prMin != null) params.set("price_min", String(prMin));
      if (prMax != null) params.set("price_max", String(prMax));
      if (tf && tf.length > 0) params.set("tags", tf.join("|"));
      const qs = params.toString();
      return "/shop" + (qs ? "?" + qs : "");
    };
    const pushShopUrl = (cat, coll, search, af, replace, vf, prMin, prMax, tf) => {
      const url = buildShopUrl(cat, coll, search, af, vf, prMin, prMax, tf);
      const state = { view: "browse", cat, coll, search, filters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, page: currentPage, scrollPos: scrollY.current };
      if (replace) history.replaceState(state, "", url);
      else history.pushState(state, "", url);
    };
    const fetchCart = () => {
      fetch(API + "/api/cart?session_id=" + encodeURIComponent(sessionId.current)).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setCart(data.cart || [])).catch((err) => console.error(err));
    };
    const addToCart = (item) => {
      fetch(API + "/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...item, session_id: sessionId.current })
      }).then((r) => r.json().then((data) => ({ ok: r.ok, data }))).then(({ ok, data }) => {
        if (!ok || data.error) {
          showToast(data.error || "Failed to add to cart", "error");
          return;
        }
        if (data.item) {
          setCart((prev) => {
            const existing = prev.findIndex((i) => i.id === data.item.id);
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = data.item;
              return updated;
            }
            return [...prev, data.item];
          });
          setCartFlash(true);
          setTimeout(() => setCartFlash(false), 600);
          showToast("Added to cart", "success");
          setCartDrawerOpen(true);
          track("add_to_cart", { sku_id: item.sku_id, is_sample: !!item.is_sample });
        }
      }).catch((err) => console.error(err));
    };
    const removeFromCart = (itemId) => {
      fetch(API + "/api/cart/" + itemId + "?session_id=" + encodeURIComponent(sessionId.current), { method: "DELETE" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(() => setCart((prev) => prev.filter((i) => i.id !== itemId))).catch((err) => console.error(err));
    };
    const updateCartItem = (itemId, updates) => {
      fetch(API + "/api/cart/" + itemId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...updates, session_id: sessionId.current })
      }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        if (data.item) setCart((prev) => prev.map((i) => i.id === itemId ? data.item : i));
      }).catch((err) => console.error(err));
    };
    const handleTradeLogin = (token, cust) => {
      localStorage.setItem("trade_token", token);
      setTradeToken(token);
      setTradeCustomer(cust);
      setShowTradeModal(false);
      fetchSkus({ cat: selectedCategory, coll: selectedCollection, search: searchQuery, activeFilters: filters, page: currentPage });
    };
    const handleTradeLogout = () => {
      const t = localStorage.getItem("trade_token");
      if (t) fetch(API + "/api/trade/logout", { method: "POST", headers: { "X-Trade-Token": t } }).catch(() => {
      });
      localStorage.removeItem("trade_token");
      setTradeToken(null);
      setTradeCustomer(null);
      fetchSkus({ cat: selectedCategory, coll: selectedCollection, search: searchQuery, activeFilters: filters, page: currentPage });
    };
    const handleCustomerLogin = (token, cust, remember) => {
      if (remember === false) {
        sessionStorage.setItem("customer_token", token);
        localStorage.removeItem("customer_token");
      } else {
        localStorage.setItem("customer_token", token);
      }
      setCustomerToken(token);
      setCustomer(cust);
      setShowAuthModal(false);
      syncWishlistOnLogin(token);
      if (view === "signin" || view === "signup" || view === "set-password" || view === "reset-password") {
        setView("account");
        history.pushState({ view: "account" }, "", "/account");
        window.scrollTo(0, 0);
      }
    };
    const handleCustomerLogout = () => {
      const t = localStorage.getItem("customer_token") || sessionStorage.getItem("customer_token");
      if (t) fetch(API + "/api/customer/logout", { method: "POST", headers: { "X-Customer-Token": t } }).catch(() => {
      });
      localStorage.removeItem("customer_token");
      sessionStorage.removeItem("customer_token");
      setCustomerToken(null);
      setCustomer(null);
    };
    const toggleWishlist2 = (skuId) => {
      const isWished = wishlist.includes(skuId);
      let updated;
      if (isWished) {
        updated = wishlist.filter((id) => id !== skuId);
        showToast("Removed from wishlist", "info");
      } else {
        updated = [skuId, ...wishlist];
        showToast("Added to wishlist", "success");
      }
      setWishlist(updated);
      try {
        localStorage.setItem("wishlist", JSON.stringify(updated));
      } catch (e) {
      }
      const custToken = localStorage.getItem("customer_token");
      if (custToken) {
        if (isWished) {
          fetch(API + "/api/wishlist/" + skuId, { method: "DELETE", headers: { "X-Customer-Token": custToken } }).catch(() => {
          });
        } else {
          fetch(API + "/api/wishlist", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Customer-Token": custToken },
            body: JSON.stringify({ sku_id: skuId })
          }).catch(() => {
          });
        }
      }
    };
    const syncWishlistOnLogin = (token) => {
      let localWishlist;
      try {
        localWishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
      } catch (e) {
        localWishlist = [];
      }
      if (localWishlist.length > 0) {
        fetch(API + "/api/wishlist/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Customer-Token": token },
          body: JSON.stringify({ sku_ids: localWishlist })
        }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((data) => {
          if (data.sku_ids) {
            setWishlist(data.sku_ids);
            localStorage.setItem("wishlist", JSON.stringify(data.sku_ids));
          }
        }).catch(() => {
        });
      } else {
        fetch(API + "/api/wishlist", { headers: { "X-Customer-Token": token } }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((data) => {
          if (data.sku_ids) {
            setWishlist(data.sku_ids);
            localStorage.setItem("wishlist", JSON.stringify(data.sku_ids));
          }
        }).catch(() => {
        });
      }
    };
    const goHome = () => {
      setView("home");
      history.pushState({ view: "home" }, "", "/");
      window.scrollTo(0, 0);
    };
    const goWishlist = () => {
      setView("wishlist");
      history.pushState({ view: "wishlist" }, "", "/wishlist");
      window.scrollTo(0, 0);
    };
    const goCollections = () => {
      setView("collections");
      history.pushState({ view: "collections" }, "", "/collections");
      window.scrollTo(0, 0);
    };
    const goTrade = () => {
      setView("trade");
      history.pushState({ view: "trade" }, "", "/trade");
      window.scrollTo(0, 0);
    };
    const goTradeDashboard = () => {
      setView("trade-dashboard");
      history.pushState({ view: "trade-dashboard" }, "", "/trade/dashboard");
      window.scrollTo(0, 0);
    };
    const goBulkOrder = () => {
      setView("bulk-order");
      history.pushState({ view: "bulk-order" }, "", "/trade/bulk-order");
      window.scrollTo(0, 0);
    };
    const goInstallation = () => {
      setView("installation");
      history.pushState({ view: "installation" }, "", "/installation");
      window.scrollTo(0, 0);
    };
    const goInspiration = () => {
      setView("inspiration");
      history.pushState({ view: "inspiration" }, "", "/inspiration");
      window.scrollTo(0, 0);
    };
    const goSale = () => {
      setView("sale");
      history.pushState({ view: "sale" }, "", "/sale");
      window.scrollTo(0, 0);
    };
    const goCabinets = () => {
      setView("cabinets");
      history.pushState({ view: "cabinets" }, "", "/cabinets");
      window.scrollTo(0, 0);
    };
    const [comingSoonTitle, setComingSoonTitle] = useState("");
    const [newsletterEmail, setNewsletterEmail] = useState("");
    const [newsletterSubmitted, setNewsletterSubmitted] = useState(false);
    const handleNewsletterSubmit = (e) => {
      e.preventDefault();
      if (!newsletterEmail) return;
      fetch(API + "/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newsletterEmail })
      }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(() => {
        setNewsletterSubmitted(true);
      }).catch(() => {
        setNewsletterSubmitted(true);
      });
    };
    const navigate = (path) => {
      if (path.startsWith("/shop?")) {
        const sp = new URLSearchParams(path.split("?")[1]);
        setSelectedCategory(null);
        setSelectedCollection(null);
        setSearchQuery("");
        setFilters({});
        setVendorFilters([]);
        setTagFilters([]);
        setUserPriceRange({ min: null, max: null });
        setCurrentPage(1);
        const sortVal = sp.get("sort");
        if (sortVal) setSortBy(sortVal);
        setView("browse");
        fetchSkus({ cat: null, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: sortVal || sortBy });
        fetchFacets({ cat: null, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
        history.pushState({ view: "browse" }, "", path);
        window.scrollTo(0, 0);
        return;
      }
      if (path === "/signin" || path === "/signup" || path === "/forgot-password") {
        const viewName = path.slice(1);
        setView(viewName);
        history.pushState({ view: viewName }, "", path);
        window.scrollTo(0, 0);
        return;
      }
      if (path === "/installation") {
        goInstallation();
        return;
      }
      if (path === "/inspiration") {
        goInspiration();
        return;
      }
      if (path === "/sale") {
        goSale();
        return;
      }
      if (path === "/cabinets") {
        goCabinets();
        return;
      }
      if (path === "/terms" || path === "/privacy" || path === "/accessibility" || path === "/about") {
        const viewName = path.slice(1);
        setView(viewName);
        history.pushState({ view: viewName }, "", path);
        window.scrollTo(0, 0);
        return;
      }
      const servicePages = {
        "/design-services": "Design Services"
      };
      if (servicePages[path]) {
        setComingSoonTitle(servicePages[path]);
        setView("coming-soon");
        history.pushState({ view: "coming-soon", title: servicePages[path] }, "", path);
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
      setView("browse");
      fetchSkus({ cat: null, coll: collectionName, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
      fetchFacets({ cat: null, coll: collectionName, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
      pushShopUrl(null, collectionName, "", {}, false, [], null, null, []);
      window.scrollTo(0, 0);
    };
    const goBrowse = () => {
      setView("browse");
      setSelectedCollection(null);
      setSearchQuery("");
      setFilters({});
      setVendorFilters([]);
      setTagFilters([]);
      setUserPriceRange({ min: null, max: null });
      setCurrentPage(1);
      setSelectedCategory(null);
      history.pushState({ view: "browse" }, "", "/shop");
      window.scrollTo(0, 0);
    };
    const goSkuDetail = (skuId, productName) => {
      const fromDetail = view === "detail";
      if (view === "browse" || view === "home") scrollY.current = window.scrollY;
      setSelectedSkuId(skuId);
      setView("detail");
      const slug = generateSlug(productName || "product");
      history.pushState({ view: "detail", skuId, _fromDetail: fromDetail }, "", "/shop/sku/" + skuId + "/" + slug);
      window.scrollTo(0, 0);
      track("product_view", { sku_id: skuId });
    };
    const goBackToBrowse = () => {
      const prev = history.state;
      if (prev && prev._fromDetail) {
        history.back();
        return;
      }
      setView("browse");
      pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, false, vendorFilters, userPriceRange.min, userPriceRange.max, tagFilters);
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, scrollY.current)));
    };
    const goCart = () => {
      setView("cart");
      setCartDrawerOpen(false);
      history.pushState({ view: "cart" }, "", "/cart");
      window.scrollTo(0, 0);
    };
    const goCheckout = () => {
      setView("checkout");
      setCartDrawerOpen(false);
      history.pushState({ view: "checkout" }, "", "/checkout");
      window.scrollTo(0, 0);
      track("checkout_started", { item_count: cart.length });
    };
    const goAccount = () => {
      setView("account");
      history.pushState({ view: "account" }, "", "/account");
      window.scrollTo(0, 0);
    };
    const handleOrderComplete = (orderData) => {
      setCompletedOrder(orderData);
      setCart([]);
      setView("confirmation");
      history.pushState({ view: "confirmation" }, "", "/checkout/confirmation");
      window.scrollTo(0, 0);
      track("order_completed", { order_number: orderData && orderData.order ? orderData.order.order_number : void 0 });
      fetch(API + "/api/cart/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId.current })
      }).catch(() => {
      });
    };
    const finalizeKlarnaOrder = async (paymentIntentId, redirectStatus) => {
      const raw = sessionStorage.getItem("klarna_pending");
      sessionStorage.removeItem("klarna_pending");
      history.replaceState({ view: "checkout" }, "", "/checkout");
      if (redirectStatus === "failed" || !raw) {
        setView("checkout");
        setKlarnaError("Your Klarna payment wasn't completed. You can try again or choose another payment method.");
        return;
      }
      setView("checkout");
      setKlarnaFinalizing(true);
      try {
        const stash = JSON.parse(raw);
        const orderBody = { ...stash.orderBody, payment_intent_id: paymentIntentId, payment_method: "klarna" };
        const headers = { "Content-Type": "application/json" };
        if (tradeToken) headers["X-Trade-Token"] = tradeToken;
        if (customerToken) headers["X-Customer-Token"] = customerToken;
        const res = await fetch(API + "/api/checkout/place-order", { method: "POST", headers, body: JSON.stringify(orderBody) });
        const data = await res.json();
        if (data.error) {
          setKlarnaError(data.error);
          setKlarnaFinalizing(false);
          return;
        }
        if (data.customer_token && data.customer) handleCustomerLogin(data.customer_token, data.customer);
        setKlarnaFinalizing(false);
        handleOrderComplete({ order: data.order, sample_request: data.sample_request || null });
      } catch (e) {
        setKlarnaError("We couldn't finalize your Klarna order. If you were charged, please call (714) 999-0009 \u2014 no order was created.");
        setKlarnaFinalizing(false);
      }
    };
    const handleCategorySelect = (slug) => {
      setSelectedCategory(slug);
      setSelectedCollection(null);
      setSearchQuery("");
      setFilters({});
      setVendorFilters([]);
      setTagFilters([]);
      setUserPriceRange({ min: null, max: null });
      setCurrentPage(1);
      setSortBy("name_asc");
      setRelatedSearches([]);
      setMatchingCategories([]);
      fetchSkus({ cat: slug, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: "name_asc" });
      fetchFacets({ cat: slug, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
      pushShopUrl(slug, null, "", {}, false, [], null, null, []);
    };
    const handleAxisSelect = (attrSlug, value) => {
      setSelectedCategory(null);
      setSelectedCollection(null);
      setSearchQuery("");
      setFilters({ [attrSlug]: [value] });
      setVendorFilters([]);
      setTagFilters([]);
      setUserPriceRange({ min: null, max: null });
      setCurrentPage(1);
      setView("browse");
      const af = { [attrSlug]: [value] };
      fetchSkus({ cat: null, coll: null, search: "", activeFilters: af, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
      fetchFacets({ cat: null, coll: null, search: "", activeFilters: af, vendors: [], priceMin: null, priceMax: null, tags: [] });
      pushShopUrl(null, null, "", af, false, [], null, null, []);
      window.scrollTo(0, 0);
    };
    const handleFilterToggle = (slug, value) => {
      setFilters((prev) => {
        const current = prev[slug] || [];
        const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
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
      setFilters((prev) => {
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
      setVendorFilters((prev) => {
        const next = prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name];
        setCurrentPage(1);
        fetchSkus({ vendors: next, page: 1 });
        fetchFacets({ vendors: next });
        pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters, true, next, userPriceRange.min, userPriceRange.max, tagFilters);
        return next;
      });
    };
    const handleTagToggle = (slug) => {
      setTagFilters((prev) => {
        const next = prev.includes(slug) ? prev.filter((t) => t !== slug) : [...prev, slug];
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
      track("search", { query });
      setSearchQuery(query);
      setSearchDidYouMean(null);
      setSelectedCategory(null);
      setSelectedCollection(null);
      setFilters({});
      setVendorFilters([]);
      setTagFilters([]);
      setUserPriceRange({ min: null, max: null });
      setCurrentPage(1);
      setSortBy("relevance");
      setView("browse");
      fetchSkus({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1, sort: "relevance" });
      fetchFacets({ cat: null, coll: null, search: query, activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
      pushShopUrl(null, null, query, {}, false, [], null, null, []);
      setRelatedSearches([]);
      fetch(API + "/api/storefront/search/related?q=" + encodeURIComponent(query)).then((r) => r.ok ? r.json() : { terms: [] }).then((d) => setRelatedSearches(d.terms || [])).catch(() => {
      });
      fetch(API + "/api/storefront/search/suggest?q=" + encodeURIComponent(query)).then((r) => r.ok ? r.json() : { categories: [] }).then((d) => setMatchingCategories(d.categories || [])).catch(() => {
      });
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
    useEffect(() => {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      window.scrollTo(0, 0);
      fetchCart();
      fetch(API + "/api/categories").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setCategories(data.categories || [])).catch((err) => console.error(err));
      const savedToken = localStorage.getItem("trade_token");
      if (savedToken) {
        fetch(API + "/api/trade/me", { headers: { "X-Trade-Token": savedToken } }).then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        }).then((data) => {
          setTradeCustomer(data.customer);
          setTradeToken(savedToken);
        }).catch(() => {
          localStorage.removeItem("trade_token");
          setTradeToken(null);
        });
      }
      const savedCustToken = localStorage.getItem("customer_token") || sessionStorage.getItem("customer_token");
      if (savedCustToken) {
        fetch(API + "/api/customer/me", { headers: { "X-Customer-Token": savedCustToken } }).then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        }).then((data) => {
          setCustomer(data.customer);
          setCustomerToken(savedCustToken);
        }).catch(() => {
          localStorage.removeItem("customer_token");
          sessionStorage.removeItem("customer_token");
          setCustomerToken(null);
        });
      }
      fetch(API + "/api/storefront/featured").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setFeaturedSkus(data.skus || []);
        setFeaturedLoading(false);
      }).catch(() => {
        setFeaturedLoading(false);
      });
      fetch(API + "/api/storefront/facets").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setGlobalFacets(data.facets || [])).catch(console.error);
      const rawPath = window.location.pathname;
      const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("payment_intent") && sp.get("redirect_status") && sessionStorage.getItem("klarna_pending")) {
        finalizeKlarnaOrder(sp.get("payment_intent"), sp.get("redirect_status"));
      } else if (sp.get("reset_token")) {
        setView("reset-password");
      } else if (path === "/" || path === "") {
        setView("home");
      } else if (path.startsWith("/shop/sku/")) {
        const parts = path.replace("/shop/sku/", "").split("/");
        setSelectedSkuId(parts[0]);
        setView("detail");
      } else if (path === "/cart" || path === "/shop/cart") {
        setView("cart");
      } else if (path === "/checkout" || path === "/shop/checkout") {
        setView("checkout");
      } else if (path === "/account" && sp.get("action") === "set-password" && sp.get("token")) {
        setView("set-password");
      } else if (path === "/account" || path === "/shop/account") {
        setView("account");
      } else if (path === "/wishlist" || path === "/shop/wishlist") {
        setView("wishlist");
      } else if (path === "/collections" || path === "/shop/collections") {
        setView("collections");
      } else if (path.startsWith("/collections/")) {
        const slug = path.replace("/collections/", "");
        setSelectedCollection(slug);
        setView("browse");
        fetchSkus({ coll: slug, activeFilters: {}, tags: [] });
        fetchFacets({ coll: slug, activeFilters: {}, tags: [] });
      } else if (path === "/trade" && !path.startsWith("/trade/")) {
        setView("trade");
      } else if (path === "/trade/dashboard" || path === "/shop/trade") {
        setView("trade-dashboard");
      } else if (path === "/trade/bulk-order") {
        setView("bulk-order");
      } else if (path.startsWith("/visit/")) {
        setVisitRecapToken(path.replace("/visit/", ""));
        setView("visit-recap");
      } else if (path === "/reset-password") {
        setView("reset-password");
      } else if (path === "/signin") {
        setView("signin");
      } else if (path === "/signup") {
        setView("signup");
      } else if (path === "/forgot-password") {
        setView("forgot-password");
      } else if (path === "/installation") {
        setView("installation");
      } else if (path === "/inspiration") {
        setView("inspiration");
      } else if (path === "/sale") {
        setView("sale");
      } else if (path === "/cabinets") {
        setView("cabinets");
      } else if (path === "/terms") {
        setView("terms");
      } else if (path === "/privacy") {
        setView("privacy");
      } else if (path === "/accessibility") {
        setView("accessibility");
      } else if (path === "/about") {
        setView("about");
      } else if (path === "/design-services") {
        setComingSoonTitle("Design Services");
        setView("coming-soon");
      } else if (path === "/shop" || path.startsWith("/shop")) {
        setView("browse");
        const cat = sp.get("category");
        const coll = sp.get("collection");
        const q = sp.get("q");
        const reserved = ["category", "collection", "q", "vendor", "price_min", "price_max", "sort", "tags"];
        const af = {};
        sp.forEach((val, key) => {
          if (!reserved.includes(key)) af[key] = val.split("|");
        });
        const vf = sp.get("vendor") ? sp.get("vendor").split("|") : [];
        const prMin = sp.get("price_min") ? parseFloat(sp.get("price_min")) : null;
        const prMax = sp.get("price_max") ? parseFloat(sp.get("price_max")) : null;
        const tf = sp.get("tags") ? sp.get("tags").split("|") : [];
        if (cat) setSelectedCategory(cat);
        if (coll) setSelectedCollection(coll);
        if (q) {
          setSearchQuery(q);
          setSortBy("relevance");
        }
        if (Object.keys(af).length) setFilters(af);
        if (vf.length) setVendorFilters(vf);
        if (tf.length) setTagFilters(tf);
        if (prMin != null || prMax != null) setUserPriceRange({ min: prMin, max: prMax });
        if (cat || coll || q || Object.keys(af).length > 0 || vf.length > 0 || tf.length > 0) {
          fetchSkus({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, sort: q ? "relevance" : void 0 });
          fetchFacets({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
          if (q) {
            fetch(API + "/api/storefront/search/related?q=" + encodeURIComponent(q)).then((r) => r.ok ? r.json() : { terms: [] }).then((d) => setRelatedSearches(d.terms || [])).catch(() => {
            });
            fetch(API + "/api/storefront/search/suggest?q=" + encodeURIComponent(q)).then((r) => r.ok ? r.json() : { categories: [] }).then((d) => setMatchingCategories(d.categories || [])).catch(() => {
            });
          }
        }
      } else {
        setView("home");
      }
      const handlePop = (e) => {
        const state = e.state;
        if (state && state.view) {
          setView(state.view);
          if (state.view === "detail" && state.skuId) setSelectedSkuId(state.skuId);
          if (state.view === "browse") {
            setSelectedCategory(state.cat || null);
            setSelectedCollection(state.coll || null);
            setSearchQuery(state.search || "");
            setFilters(state.filters || {});
            setVendorFilters(state.vendors || []);
            setTagFilters(state.tags || []);
            setUserPriceRange({ min: state.priceMin != null ? state.priceMin : null, max: state.priceMax != null ? state.priceMax : null });
            const savedPage = state.page || 1;
            const savedScroll = state.scrollPos || 0;
            setCurrentPage(savedPage);
            scrollY.current = savedScroll;
            pendingScroll.current = savedScroll;
            fetchSkusRef.current({ cat: state.cat, coll: state.coll, search: state.search || "", activeFilters: state.filters || {}, vendors: state.vendors || [], priceMin: state.priceMin, priceMax: state.priceMax, tags: state.tags || [], page: savedPage });
            fetchFacetsRef.current({ cat: state.cat, coll: state.coll, search: state.search || "", activeFilters: state.filters || {}, vendors: state.vendors || [], priceMin: state.priceMin, priceMax: state.priceMax, tags: state.tags || [] });
          }
          if (state.view === "visit-recap" && state.token) setVisitRecapToken(state.token);
          if (state.view === "coming-soon" && state.title) setComingSoonTitle(state.title);
        } else {
          const rawP = window.location.pathname;
          const p = rawP.length > 1 && rawP.endsWith("/") ? rawP.slice(0, -1) : rawP;
          if (p === "/" || p === "") {
            setView("home");
          } else if (p.startsWith("/shop/sku/")) {
            const parts = p.replace("/shop/sku/", "").split("/");
            setSelectedSkuId(parts[0]);
            setView("detail");
          } else if (p === "/trade") {
            setView("trade");
          } else if (p === "/trade/dashboard") {
            setView("trade-dashboard");
          } else if (p === "/sale") {
            setView("sale");
          } else if (p === "/cabinets") {
            setView("cabinets");
          } else if (p === "/about") {
            setView("about");
          } else if (p.startsWith("/visit/")) {
            setVisitRecapToken(p.replace("/visit/", ""));
            setView("visit-recap");
          } else {
            setView("browse");
            const sp2 = new URLSearchParams(window.location.search);
            const cat = sp2.get("category");
            const coll = sp2.get("collection");
            const q = sp2.get("q");
            const reserved2 = ["category", "collection", "q", "vendor", "price_min", "price_max", "sort", "tags"];
            const af = {};
            sp2.forEach((val, key) => {
              if (!reserved2.includes(key)) af[key] = val.split("|");
            });
            const vf = sp2.get("vendor") ? sp2.get("vendor").split("|") : [];
            const prMin = sp2.get("price_min") ? parseFloat(sp2.get("price_min")) : null;
            const prMax = sp2.get("price_max") ? parseFloat(sp2.get("price_max")) : null;
            const tf = sp2.get("tags") ? sp2.get("tags").split("|") : [];
            setSelectedCategory(cat);
            setSelectedCollection(coll);
            setSearchQuery(q || "");
            if (Object.keys(af).length) setFilters(af);
            setVendorFilters(vf);
            setTagFilters(tf);
            setUserPriceRange({ min: prMin, max: prMax });
            setCurrentPage(1);
            fetchSkusRef.current({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf, page: 1 });
            fetchFacetsRef.current({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
          }
        }
      };
      window.addEventListener("popstate", handlePop);
      return () => window.removeEventListener("popstate", handlePop);
    }, []);
    useEffect(() => {
      const seoMap = {
        home: { title: "Roma Flooring Designs | Premium Flooring & Tile in Anaheim, CA", description: "Roma Flooring Designs offers premium flooring, tile, stone, and countertop products in Anaheim, CA.", url: SITE_URL + "/" },
        browse: { title: "Shop All | Roma Flooring Designs", description: "Browse premium flooring, tile, stone, and countertop products.", url: SITE_URL + "/shop" },
        cart: { title: "Cart | Roma Flooring Designs", description: "Review your cart.", url: SITE_URL + "/cart" },
        checkout: { title: "Checkout | Roma Flooring Designs", description: "Complete your order.", url: SITE_URL + "/checkout" },
        collections: { title: "Collections | Roma Flooring Designs", description: "Explore our curated flooring collections from premium vendors.", url: SITE_URL + "/collections" },
        wishlist: { title: "Wishlist | Roma Flooring Designs", description: "Your saved products.", url: SITE_URL + "/wishlist" },
        account: { title: "My Account | Roma Flooring Designs", description: "Manage your account and orders.", url: SITE_URL + "/account" },
        trade: { title: "Trade Program | Roma Flooring Designs", description: "Join our trade program for exclusive pricing and dedicated support.", url: SITE_URL + "/trade" },
        "trade-dashboard": { title: "Trade Dashboard | Roma Flooring Designs", description: "Manage your trade account.", url: SITE_URL + "/trade/dashboard" },
        "bulk-order": { title: "Bulk Order | Roma Flooring Designs", description: "Place a bulk order.", url: SITE_URL + "/trade/bulk-order" },
        "reset-password": { title: "Reset Password | Roma Flooring Designs", description: "Reset your password.", url: SITE_URL + "/reset-password" },
        signin: { title: "Sign In | Roma Flooring Designs", description: "Sign in to your Roma Flooring Designs account.", url: SITE_URL + "/signin" },
        signup: { title: "Create Account | Roma Flooring Designs", description: "Create your Roma Flooring Designs account.", url: SITE_URL + "/signup" },
        "forgot-password": { title: "Forgot Password | Roma Flooring Designs", description: "Reset your Roma Flooring Designs password.", url: SITE_URL + "/forgot-password" },
        about: { title: "About Us | Roma Flooring Designs", description: "A family flooring house in Anaheim, California \u2014 hardwood, stone, tile, and cabinetry since 2010. Visit our showroom on State College Blvd.", url: SITE_URL + "/about" }
      };
      if (view === "browse" && selectedCategory) {
        const catObj = categories.find((c) => c.slug === selectedCategory);
        const catName = catObj ? catObj.name : selectedCategory.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        updateSEO({ title: catName + " Flooring | Roma Flooring Designs", description: "Browse premium " + catName.toLowerCase() + " flooring products at Roma Flooring Designs.", url: SITE_URL + "/shop?category=" + encodeURIComponent(selectedCategory) });
      } else if (view === "browse" && selectedCollection) {
        const collName = selectedCollection.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        updateSEO({ title: collName + " | Roma Flooring Designs", description: "Explore the " + collName + " collection at Roma Flooring Designs.", url: SITE_URL + "/collections/" + encodeURIComponent(selectedCollection) });
      } else if (seoMap[view]) {
        updateSEO(seoMap[view]);
      }
      if (view === "browse") {
        const crumbs = [{ "@type": "ListItem", position: 1, name: "Home", item: SITE_URL + "/" }, { "@type": "ListItem", position: 2, name: "Shop", item: SITE_URL + "/shop" }];
        if (selectedCategory) {
          const catObj = categories.find((c) => c.slug === selectedCategory);
          const catName = catObj ? catObj.name : selectedCategory.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          crumbs.push({ "@type": "ListItem", position: 3, name: catName, item: SITE_URL + "/shop?category=" + encodeURIComponent(selectedCategory) });
        }
        setDynamicJsonLd({ "@context": "https://schema.org", "@graph": [
          { "@type": "CollectionPage", name: selectedCategory ? (categories.find((c) => c.slug === selectedCategory) || {}).name || "Shop" : "Shop All", url: selectedCategory ? SITE_URL + "/shop?category=" + encodeURIComponent(selectedCategory) : SITE_URL + "/shop" },
          { "@type": "BreadcrumbList", itemListElement: crumbs }
        ] });
      } else if (view === "collections") {
        setDynamicJsonLd({ "@context": "https://schema.org", "@graph": [
          { "@type": "CollectionPage", name: "Collections", url: SITE_URL + "/collections" },
          { "@type": "BreadcrumbList", itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL + "/" },
            { "@type": "ListItem", position: 2, name: "Collections", item: SITE_URL + "/collections" }
          ] }
        ] });
      } else if (view === "trade") {
        setDynamicJsonLd({ "@context": "https://schema.org", "@graph": [
          { "@type": "WebPage", name: "Trade Program", url: SITE_URL + "/trade", description: "Join our trade program for exclusive pricing and dedicated support." },
          { "@type": "BreadcrumbList", itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL + "/" },
            { "@type": "ListItem", position: 2, name: "Trade Program", item: SITE_URL + "/trade" }
          ] }
        ] });
      } else if (view !== "detail") {
        const ldEl = document.getElementById("dynamic-jsonld");
        if (ldEl) ldEl.remove();
      }
      if (view === "browse" && currentPage > 1) {
        let robotsMeta = document.querySelector('meta[data-paginated="true"]');
        if (!robotsMeta) {
          robotsMeta = document.createElement("meta");
          robotsMeta.setAttribute("name", "robots");
          robotsMeta.setAttribute("data-paginated", "true");
          document.head.appendChild(robotsMeta);
        }
        robotsMeta.setAttribute("content", "noindex,follow");
      } else {
        const robotsMeta = document.querySelector('meta[data-paginated="true"]');
        if (robotsMeta) robotsMeta.remove();
      }
    }, [view, selectedCategory, selectedCollection, categories, currentPage]);
    const isAuthPage = view === "signin" || view === "signup" || view === "forgot-password" || view === "set-password";
    const isCheckoutFlow = view === "checkout" || view === "confirmation" || isAuthPage;
    return /* @__PURE__ */ React.createElement(React.Fragment, null, !isCheckoutFlow && /* @__PURE__ */ React.createElement(
      Header,
      {
        goHome,
        goBrowse,
        cart,
        cartDrawerOpen,
        setCartDrawerOpen,
        cartFlash,
        onSearch: handleSearch,
        onSkuClick: goSkuDetail,
        tradeCustomer,
        onTradeClick: tradeCustomer ? goTradeDashboard : goTrade,
        onTradeLogout: handleTradeLogout,
        customer,
        onAccountClick: customer ? goAccount : () => navigate("/signin"),
        onCustomerLogout: handleCustomerLogout,
        wishlistCount: wishlist.length,
        goWishlist,
        goCollections,
        categories,
        onCategorySelect: (slug) => {
          handleCategorySelect(slug);
          setView("browse");
        },
        globalFacets,
        onAxisSelect: handleAxisSelect,
        mobileNavOpen,
        setMobileNavOpen,
        mobileSearchOpen,
        setMobileSearchOpen,
        view,
        navigate,
        goSale
      }
    ), view === "home" && /* @__PURE__ */ React.createElement(
      HomePage,
      {
        featuredSkus,
        featuredLoading,
        categories,
        onSkuClick: goSkuDetail,
        onCategorySelect: (slug) => {
          handleCategorySelect(slug);
          setView("browse");
        },
        goBrowse,
        goTrade,
        goCabinets,
        navigate,
        wishlist,
        toggleWishlist: toggleWishlist2,
        setQuickViewSku,
        newsletterEmail,
        setNewsletterEmail,
        newsletterSubmitted,
        onNewsletterSubmit: handleNewsletterSubmit,
        onOpenQuiz: () => setShowFloorQuiz(true)
      }
    ), view === "browse" && (!selectedCategory && !selectedCollection && !searchQuery ? /* @__PURE__ */ React.createElement(
      ShopLanding,
      {
        categories,
        featuredSkus,
        featuredLoading,
        onCategorySelect: (slug) => {
          handleCategorySelect(slug);
          setView("browse");
        },
        onSkuClick: goSkuDetail,
        goTrade,
        navigate
      }
    ) : /* @__PURE__ */ React.createElement(
      BrowseView,
      {
        skus,
        totalSkus,
        loading: loadingSkus,
        categories,
        selectedCategory,
        selectedCollection,
        searchQuery,
        onCategorySelect: handleCategorySelect,
        onSearch: handleSearch,
        facets,
        filters,
        onFilterToggle: handleFilterToggle,
        onBatchFilterSet: handleBatchFilterSet,
        onClearFilters: handleClearFilters,
        sortBy,
        onSortChange: handleSortChange,
        onSkuClick: goSkuDetail,
        currentPage,
        onPageChange: handlePageChange,
        wishlist,
        toggleWishlist: toggleWishlist2,
        setQuickViewSku,
        filterDrawerOpen,
        setFilterDrawerOpen,
        goHome,
        vendorFacets,
        vendorFilters,
        onVendorToggle: handleVendorToggle,
        priceRange,
        userPriceRange,
        onPriceRangeChange: handlePriceRangeChange,
        tagFacets,
        tagFilters,
        onTagToggle: handleTagToggle,
        didYouMean: searchDidYouMean,
        searchTimeMs,
        relatedSearches,
        matchingCategories
      }
    )), view === "detail" && selectedSkuId && /* @__PURE__ */ React.createElement(
      SkuDetailView,
      {
        key: selectedSkuId,
        skuId: selectedSkuId,
        goBack: goBackToBrowse,
        addToCart,
        cart,
        onSkuClick: goSkuDetail,
        onRequestInstall: (p) => {
          setInstallModalProduct(p);
          setShowInstallModal(true);
        },
        tradeCustomer,
        wishlist,
        toggleWishlist: toggleWishlist2,
        recentlyViewed,
        addRecentlyViewed,
        customer,
        customerToken,
        onShowAuth: () => {
          setAuthModalMode("login");
          setShowAuthModal(true);
        },
        showToast,
        categories
      }
    ), view === "cart" && /* @__PURE__ */ React.createElement(
      CartPage,
      {
        cart,
        goBrowse,
        removeFromCart,
        updateCartItem,
        goCheckout,
        deliveryMethod,
        setDeliveryMethod,
        liftgateEnabled,
        setLiftgateEnabled,
        sessionId: sessionId.current,
        appliedPromoCode,
        setAppliedPromoCode,
        goHome
      }
    ), view === "checkout" && klarnaFinalizing && /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 480, margin: "6rem auto", padding: "0 1.5rem", textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { className: "spinner", style: { margin: "0 auto 1.5rem" } }), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: "1.75rem", fontWeight: 400, marginBottom: "0.5rem" } }, "Completing your order"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.9375rem" } }, "Confirming your Klarna payment \u2014 just a moment.")), view === "checkout" && !klarnaFinalizing && /* @__PURE__ */ React.createElement(
      CheckoutPage,
      {
        cart,
        sessionId: sessionId.current,
        goCart,
        handleOrderComplete,
        deliveryMethod,
        setDeliveryMethod,
        liftgateEnabled,
        tradeCustomer,
        tradeToken,
        customer,
        customerToken,
        onCustomerLogin: handleCustomerLogin,
        klarnaError,
        clearKlarnaError: () => setKlarnaError(""),
        appliedPromoCode,
        setAppliedPromoCode
      }
    ), view === "confirmation" && /* @__PURE__ */ React.createElement(ConfirmationPage, { orderData: completedOrder, goBrowse }), view === "account" && (customer ? /* @__PURE__ */ React.createElement(AccountPage, { customer, customerToken, setCustomer, goBrowse }) : /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "4rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, marginBottom: "1rem" } }, "Sign In Required"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Please sign in to view your account."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      setAuthModalMode("login");
      setShowAuthModal(true);
    } }, "Sign In"))), view === "wishlist" && /* @__PURE__ */ React.createElement(WishlistPage, { wishlist, toggleWishlist: toggleWishlist2, onSkuClick: goSkuDetail, goBrowse, recentlyViewed, goHome }), view === "collections" && /* @__PURE__ */ React.createElement(CollectionsPage, { onCollectionClick: handleCollectionClick, goHome }), view === "trade" && /* @__PURE__ */ React.createElement(TradePage, { goTradeDashboard, onApplyClick: () => {
      setTradeModalMode("register");
      setShowTradeModal(true);
    }, tradeCustomer }), view === "trade-dashboard" && (tradeCustomer ? /* @__PURE__ */ React.createElement(TradeDashboard, { tradeCustomer, tradeToken, addToCart, goBrowse, setTradeCustomer, handleTradeLogout, goBulkOrder, showToast }) : /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "4rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, marginBottom: "1rem" } }, "Trade Login Required"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Please sign in with your trade account to access the dashboard."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      setTradeModalMode("login");
      setShowTradeModal(true);
    } }, "Trade Sign In"))), view === "bulk-order" && /* @__PURE__ */ React.createElement(BulkOrderPage, { tradeToken, addToCart, goTradeDashboard, showToast }), view === "visit-recap" && visitRecapToken && /* @__PURE__ */ React.createElement(VisitRecapPage, { token: visitRecapToken, onSkuClick: goSkuDetail }), view === "reset-password" && /* @__PURE__ */ React.createElement(ResetPasswordPage, { goHome, onLogin: handleCustomerLogin, openLogin: () => {
      setAuthModalMode("login");
      setShowAuthModal(true);
    } }), view === "set-password" && /* @__PURE__ */ React.createElement(SetPasswordPage, { onLogin: handleCustomerLogin, goHome, navigate }), view === "signin" && /* @__PURE__ */ React.createElement(SignInFullPage, { onLogin: handleCustomerLogin, goHome, navigate }), view === "signup" && /* @__PURE__ */ React.createElement(SignUpFullPage, { onLogin: handleCustomerLogin, goHome, navigate }), view === "forgot-password" && /* @__PURE__ */ React.createElement(ForgotPasswordFullPage, { goHome, navigate }), view === "installation" && /* @__PURE__ */ React.createElement(InstallationPage, { onRequestQuote: () => {
      setInstallModalProduct(null);
      setShowInstallModal(true);
    } }), view === "inspiration" && /* @__PURE__ */ React.createElement(InspirationPage, { navigate, goBrowse }), view === "sale" && /* @__PURE__ */ React.createElement(SalePage, { onSkuClick: goSkuDetail, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku, navigate }), view === "cabinets" && /* @__PURE__ */ React.createElement(CabinetsPage, null), view === "about" && /* @__PURE__ */ React.createElement(AboutPage, { navigate }), view === "coming-soon" && /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "6rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, fontSize: "2.5rem", marginBottom: "1rem" } }, comingSoonTitle), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "1.125rem", lineHeight: 1.6, marginBottom: "2rem" } }, "This page is coming soon. We're working on something beautiful."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goHome }, "Back to Home")), view === "terms" && /* @__PURE__ */ React.createElement(LegalPage, { kind: "terms", goHome, navigate }), view === "privacy" && /* @__PURE__ */ React.createElement(LegalPage, { kind: "privacy", goHome, navigate }), view === "accessibility" && /* @__PURE__ */ React.createElement(LegalPage, { kind: "accessibility", goHome, navigate }), /* @__PURE__ */ React.createElement(CookieConsent, { navigate }), /* @__PURE__ */ React.createElement(
      CartDrawer,
      {
        cart,
        open: cartDrawerOpen,
        onClose: () => setCartDrawerOpen(false),
        removeFromCart,
        goCart
      }
    ), quickViewSku && /* @__PURE__ */ React.createElement(QuickViewModal, { sku: quickViewSku, onClose: () => setQuickViewSku(null), addToCart, onViewDetail: (id, name) => {
      setQuickViewSku(null);
      goSkuDetail(id, name);
    } }), /* @__PURE__ */ React.createElement(
      MobileNav,
      {
        open: mobileNavOpen,
        onClose: () => setMobileNavOpen(false),
        categories,
        onCategorySelect: (slug) => {
          handleCategorySelect(slug);
          setView("browse");
        },
        globalFacets,
        onAxisSelect: handleAxisSelect,
        goHome,
        goBrowse,
        goCollections,
        goTrade,
        goAccount: () => {
          if (customer) goAccount();
          else {
            setAuthModalMode("login");
            setShowAuthModal(true);
          }
        },
        customer,
        tradeCustomer,
        onTradeClick: () => {
          setTradeModalMode("login");
          setShowTradeModal(true);
        },
        onCustomerLogout: handleCustomerLogout,
        onTradeLogout: handleTradeLogout
      }
    ), /* @__PURE__ */ React.createElement(
      MobileSearchOverlay,
      {
        open: mobileSearchOpen,
        onClose: () => setMobileSearchOpen(false),
        onSearch: handleSearch,
        onSkuClick: goSkuDetail,
        onCategorySelect: handleCategorySelect
      }
    ), showTradeModal && /* @__PURE__ */ React.createElement(TradeModal, { onClose: () => setShowTradeModal(false), onLogin: handleTradeLogin, initialMode: tradeModalMode }), showAuthModal && /* @__PURE__ */ React.createElement(CustomerAuthModal, { onClose: () => setShowAuthModal(false), onLogin: handleCustomerLogin, initialMode: authModalMode }), showInstallModal && /* @__PURE__ */ React.createElement(InstallationModal, { onClose: () => setShowInstallModal(false), product: installModalProduct }), showFloorQuiz && /* @__PURE__ */ React.createElement(FloorQuizModal, { onClose: () => setShowFloorQuiz(false), onSkuClick: goSkuDetail, onViewAll: (qs) => {
      navigate("/shop?" + qs);
    } }), !isCheckoutFlow && /* @__PURE__ */ React.createElement(
      SiteFooter,
      {
        goHome,
        goBrowse,
        goCollections,
        goTrade,
        onInstallClick: goInstallation,
        navigate
      }
    ), !isCheckoutFlow && /* @__PURE__ */ React.createElement("nav", { className: "mobile-bottom-nav" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "home" ? " active" : ""), onClick: goHome }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 22 9 12 15 12 15 22" })), "Home"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "browse" ? " active" : ""), onClick: () => setMobileSearchOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })), "Search"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item", onClick: () => setCartDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), cart.length > 0 && /* @__PURE__ */ React.createElement("span", { className: "mobile-bottom-nav-badge" }, cart.length), "Cart"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "account" ? " active" : ""), onClick: customer ? goAccount : () => navigate("/signin") }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" })), "Account")), /* @__PURE__ */ React.createElement(BackToTop, null), /* @__PURE__ */ React.createElement(ToastContainer, { toasts }));
  }
  const MEGA_PANELS = {
    services: {
      label: "Services",
      columns: [
        { title: "Design", items: [
          { name: "Free In-Home Consultation", meta: "Complimentary" },
          { name: "Design Services", meta: "Custom layouts" },
          { name: "Room Visualizer", meta: "See it in your space" },
          { name: "Sample Program", meta: "Try before you buy" }
        ] },
        { title: "Installation", items: [
          { name: "Professional Installation", meta: "Licensed & insured" },
          { name: "Measurement & Estimate", meta: "Free with purchase" },
          { name: "Demolition & Prep", meta: "Full service" },
          { name: "Furniture Moving", meta: "Available" }
        ] },
        { title: "Support", items: [
          { name: "Financing Options", meta: "0% APR available" },
          { name: "Commercial Projects", meta: "Volume pricing" },
          { name: "Warranty & Care", meta: "Maintenance guides" }
        ] }
      ],
      featured: { title: "Free In-Home Consultation", meta: "Book your complimentary design visit", image: "/uploads/homepage/consult-hero.jpg", cta: "Book Now" }
    },
    materials: {
      label: "Materials",
      columns: [
        { title: "Hard Surface", items: [
          { name: "Porcelain Tile", meta: "" },
          { name: "Ceramic Tile", meta: "" },
          { name: "Natural Stone", meta: "" },
          { name: "Hardwood", meta: "" },
          { name: "Laminate", meta: "" },
          { name: "Luxury Vinyl", meta: "" }
        ] },
        { title: "Soft Surface", items: [
          { name: "Carpet", meta: "" },
          { name: "Carpet Tile", meta: "" },
          { name: "Area Rugs", meta: "" }
        ] },
        { title: "Surfaces", items: [
          { name: "Countertops", meta: "" },
          { name: "Mosaics", meta: "" },
          { name: "Wall Tile", meta: "" },
          { name: "Outdoor & Pavers", meta: "" }
        ] }
      ],
      featured: { title: "New Porcelain Arrivals", meta: "Explore the latest collections", image: "/uploads/homepage/porcelain-featured.jpg", cta: "View Collection" }
    },
    trade: {
      label: "Trade",
      columns: [
        { title: "Program", items: [
          { name: "Trade Program Overview", meta: "Exclusive benefits", action: "trade" },
          { name: "Apply for Trade", meta: "Quick approval", action: "trade" },
          { name: "Trade Dashboard", meta: "Manage orders", action: "trade" }
        ] },
        { title: "Benefits", items: [
          { name: "Trade Pricing", meta: "Up to 40% off", action: "trade" },
          { name: "Bulk Ordering", meta: "Volume discounts", action: "trade" },
          { name: "Dedicated Rep", meta: "Personal service", action: "trade" },
          { name: "Net 30 Terms", meta: "For qualified accounts", action: "trade" }
        ] }
      ],
      featured: { title: "Trade Program", meta: "Join 500+ design professionals", image: "/uploads/homepage/trade-hero.jpg", cta: "Apply Now" }
    }
  };
  function MegaPanel({ panelId, categories, onCategorySelect, onTradeClick, navigate, shopColumns, onEnter, onClose }) {
    if (panelId === "shop") {
      const colCount2 = Math.min(shopColumns.length, 4) + 1;
      return /* @__PURE__ */ React.createElement("div", { className: "mega-panel", onMouseEnter: onEnter, onMouseLeave: onClose }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-inner" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-grid", style: { gridTemplateColumns: `repeat(${colCount2}, 1fr)` } }, shopColumns.slice(0, 4).map((col) => /* @__PURE__ */ React.createElement("div", { key: col.title, className: "mega-panel-col" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-col-title" }, col.title), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-items" }, col.items.map((item) => /* @__PURE__ */ React.createElement("button", { key: item.slug, className: `mega-panel-link${item.isViewAll ? " mega-panel-view-all" : ""}`, onClick: () => onCategorySelect(item.slug) }, item.name, !item.isViewAll && item.count > 0 && /* @__PURE__ */ React.createElement("span", { className: "mega-panel-link-meta" }, item.count)))))), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-eyebrow" }, "Featured"), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-card", onClick: () => navigate("/shop?sort=newest") }, /* @__PURE__ */ React.createElement("img", { src: "/uploads/homepage/hero.jpg", alt: "New Arrivals", loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-title" }, "New Arrivals"), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-meta" }, "Latest collections"), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-cta" }, "View \u2192")))))));
    }
    const panel = MEGA_PANELS[panelId];
    if (!panel) return null;
    const colCount = panel.columns.length + (panel.featured ? 1 : 0);
    return /* @__PURE__ */ React.createElement("div", { className: "mega-panel", onMouseEnter: onEnter, onMouseLeave: onClose }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-inner" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-grid", style: { gridTemplateColumns: `repeat(${colCount}, 1fr)` } }, panel.columns.map((col) => /* @__PURE__ */ React.createElement("div", { key: col.title, className: "mega-panel-col" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-col-title" }, col.title), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-items" }, col.items.map((item) => /* @__PURE__ */ React.createElement("button", { key: item.name, className: "mega-panel-link", onClick: () => {
      if (item.action === "trade") {
        onTradeClick();
      } else if (panelId === "materials") {
        const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        onCategorySelect(slug);
      } else {
        navigate("/shop");
      }
    } }, item.name, item.meta && /* @__PURE__ */ React.createElement("span", { className: "mega-panel-link-meta" }, item.meta)))))), panel.featured && /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-eyebrow" }, "Featured"), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-card", onClick: () => {
      if (panelId === "trade") onTradeClick();
      else navigate("/shop");
    } }, /* @__PURE__ */ React.createElement("img", { src: panel.featured.image, alt: panel.featured.title, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-title" }, panel.featured.title), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-meta" }, panel.featured.meta), /* @__PURE__ */ React.createElement("div", { className: "mega-panel-featured-cta" }, panel.featured.cta, " \u2192")))))));
  }
  function SearchPanel({ searchInput, parentCats, suggestData, suggestLoading, popularSearches, recentSearches, activeIdx, onSearch, onCategorySelect, onSkuClick, onClose, selectSuggestion, tradeCustomer, hasSuggestResults, suggestItems, navigate }) {
    const totalProducts = suggestData.categories.reduce((s, c) => s + (c.product_count || 0), 0) + suggestData.products.length;
    const clockIcon = React.createElement(
      "svg",
      { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
      React.createElement("circle", { cx: 12, cy: 12, r: 10 }),
      React.createElement("polyline", { points: "12 6 12 12 16 14" })
    );
    if (!searchInput) {
      return /* @__PURE__ */ React.createElement("div", { className: "search-panel", onMouseDown: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-inner" }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-explore" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Recent Searches"), recentSearches.length > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, recentSearches.slice(0, 6).map((term) => /* @__PURE__ */ React.createElement("button", { key: term, className: "search-panel-recent-item", onClick: () => selectSuggestion({ type: "recent", data: { term } }) }, clockIcon, /* @__PURE__ */ React.createElement("span", null, term))), /* @__PURE__ */ React.createElement("button", { className: "search-panel-clear", onClick: () => {
        clearRecentSearches();
      } }, "Clear recent")) : /* @__PURE__ */ React.createElement("div", { style: { fontFamily: "var(--font-heading)", fontSize: "0.9375rem", fontStyle: "italic", color: "var(--stone-400)" } }, "No recent searches")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label search-panel-section-label--accent" }, "Trending This Week"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-pills" }, popularSearches.slice(0, 12).map((term) => /* @__PURE__ */ React.createElement("button", { key: term, className: "search-panel-pill", onClick: () => selectSuggestion({ type: "popular", data: { term } }) }, term)))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Browse Categories"), parentCats.slice(0, 6).map((cat) => /* @__PURE__ */ React.createElement("button", { key: cat.slug, className: "search-panel-cat-row", onClick: () => {
        onClose();
        onCategorySelect(cat.slug);
      } }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-cat-swatch" }, cat.image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(cat.image, 60), alt: "", decoding: "async", loading: "lazy", width: 28, height: 28 }) : null), /* @__PURE__ */ React.createElement("span", { className: "search-panel-cat-name" }, cat.name), /* @__PURE__ */ React.createElement("span", { className: "search-panel-cat-meta" }, cat.product_count || 0)))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Featured"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo", onClick: () => {
        onClose();
        navigate("/shop?sort=newest");
      } }, /* @__PURE__ */ React.createElement("img", { src: "/uploads/homepage/new-arrivals.jpg", alt: "New Arrivals", loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo-overlay" }), /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo-title" }, "New Arrivals"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo-desc" }, "Latest collections just added"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-promo-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "search-panel-promo-price" }, "From $2.49/sqft"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-promo-cta" }, "View \u2192"))))))), /* @__PURE__ */ React.createElement("div", { className: "search-panel-footer" }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-footer-keys" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u2191"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u2193"), " Navigate"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u21B5"), " Select"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "Esc"), " Close")), /* @__PURE__ */ React.createElement("span", { className: "search-panel-footer-action", onClick: () => {
        onClose();
        navigate("/shop");
      } }, "Search 2,400+ products")));
    }
    const isLoading = suggestLoading && !hasSuggestResults;
    const isEmpty = !suggestLoading && !hasSuggestResults && searchInput.length >= 2;
    let resultIdx = 0;
    return /* @__PURE__ */ React.createElement("div", { className: "search-panel", onMouseDown: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-inner" }, isLoading && /* @__PURE__ */ React.createElement("div", { className: "search-panel-results" }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-loading" }, [0, 1, 2, 3].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-search-result", style: { animationDelay: i * 0.1 + "s" } }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-lines" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short", style: { marginTop: 0 } }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar", style: { width: 50, height: 12 } })))), /* @__PURE__ */ React.createElement("div", null)), isEmpty && /* @__PURE__ */ React.createElement("div", { className: "search-panel-results" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-empty" }, "Nothing matches yet \u2014 try", " ", popularSearches.slice(0, 3).map((term, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: term }, i > 0 && (i === 2 ? ", or " : ", "), /* @__PURE__ */ React.createElement("a", { onClick: () => selectSuggestion({ type: "popular", data: { term } }) }, term)))), suggestData.didYouMean && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1rem" } }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Did You Mean"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-dym-item" }, /* @__PURE__ */ React.createElement("button", { onClick: () => selectSuggestion({ type: "popular", data: { term: suggestData.didYouMean } }) }, suggestData.didYouMean)))), /* @__PURE__ */ React.createElement("div", null)), hasSuggestResults && /* @__PURE__ */ React.createElement("div", { className: "search-panel-results" }, /* @__PURE__ */ React.createElement("div", null, suggestData.expandedFrom && /* @__PURE__ */ React.createElement("div", { className: "search-panel-synonym-banner" }, "Showing results for ", /* @__PURE__ */ React.createElement("em", null, suggestData.expandedTo ? suggestData.expandedTo.split(" ").slice(0, 4).join(" ") : suggestData.expandedFrom), /* @__PURE__ */ React.createElement("button", { className: "search-panel-synonym-link", onClick: () => {
      selectSuggestion({ type: "popular", data: { term: suggestData.expandedFrom } });
    } }, "Search for \u201C", suggestData.expandedFrom, "\u201D only")), suggestData.autoCorrect && /* @__PURE__ */ React.createElement("div", { className: "search-panel-autocorrect-banner" }, "Showing results for ", /* @__PURE__ */ React.createElement("em", null, suggestData.autoCorrect.correctedQuery), ".", " ", /* @__PURE__ */ React.createElement("button", { className: "search-panel-synonym-link", onClick: () => selectSuggestion({ type: "popular", data: { term: searchInput } }) }, "Search instead for \u201C", searchInput, "\u201D")), /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, suggestData.total || totalProducts, " matches for \u2018", searchInput, "\u2019"), suggestData.categories.map((cat) => {
      const idx = resultIdx++;
      return /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "search-panel-result" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "category", data: cat }) }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-img" }, cat.image_url ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(cat.image_url, 120), alt: "", decoding: "async", loading: "lazy", width: 56, height: 56 }) : /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 24, height: 24, padding: 16, color: "var(--stone-400)" } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-name" }, highlightMatch(cat.name, searchInput)), /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-cat" }, "Category")), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-price" }, cat.product_count, " products"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-enter" }, "\u21B5"));
    }), suggestData.collections.map((col) => {
      const idx = resultIdx++;
      return /* @__PURE__ */ React.createElement("div", { key: col.name, className: "search-panel-result" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "collection", data: col }) }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-img search-panel-result-img--lg" }, col.image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(col.image, 120), alt: "", decoding: "async", loading: "lazy", width: 56, height: 56 }) : /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 24, height: 24, padding: 16, color: "var(--stone-400)" } }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-name" }, highlightMatch(col.name, searchInput)), /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-cat" }, "Collection")), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-price" }, col.product_count, " products"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-enter" }, "\u21B5"));
    }), suggestData.products.map((sku) => {
      const idx = resultIdx++;
      const colorInfo = sku.color_family;
      return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "search-panel-result search-panel-result--product" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "product", data: sku }) }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-img search-panel-result-img--lg" }, sku.primary_image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(sku.primary_image, 120), alt: "", decoding: "async", loading: "lazy", width: 56, height: 56 }) : /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 24, height: 24, padding: 16, color: "var(--stone-300)" } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "8.5", cy: "8.5", r: "1.5" }), /* @__PURE__ */ React.createElement("path", { d: "m21 15-5-5L5 21" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-name" }, highlightMatch(fullProductName(sku), searchInput)), /* @__PURE__ */ React.createElement("div", { className: "search-panel-result-cat" }, colorInfo && colorInfo.hex && /* @__PURE__ */ React.createElement("span", { className: "search-panel-color-dot", style: { background: colorInfo.hex }, title: colorInfo.family }), sku.brand_name || sku.vendor_name || sku.category_name || "")), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-price" }, sku.sale_price && /* @__PURE__ */ React.createElement("span", { className: "search-panel-sale-tag" }, "SALE"), "$", displayPrice(sku, skuListPrice(sku)).toFixed(2), priceSuffix(sku)), /* @__PURE__ */ React.createElement("span", { className: "search-panel-result-enter" }, "\u21B5"));
    }), /* @__PURE__ */ React.createElement("button", { className: "search-panel-seeall", onClick: () => {
      const q = searchInput.trim();
      if (q) {
        addRecentSearch(q);
      }
      onSearch(q);
      onClose();
    } }, "See all ", suggestData.total || totalProducts, " results \u2192")), /* @__PURE__ */ React.createElement("div", null, suggestData.didYouMean && /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "2rem" } }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Did You Mean"), /* @__PURE__ */ React.createElement("div", { className: "search-panel-dym-item" }, /* @__PURE__ */ React.createElement("button", { onClick: () => selectSuggestion({ type: "popular", data: { term: suggestData.didYouMean } }) }, suggestData.didYouMean))), /* @__PURE__ */ React.createElement("div", { className: "search-panel-section-label" }, "Also In"), suggestData.categories.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-panel-scope-item", onClick: () => {
      onClose();
      onSearch(searchInput);
    } }, /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-name" }, "All categories"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-meta" }, suggestData.categories.length, " matches")), suggestData.collections.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-panel-scope-item", onClick: () => {
      onClose();
      onSearch(searchInput);
    } }, /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-name" }, "Collections"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-meta" }, suggestData.collections.length, " matches")), /* @__PURE__ */ React.createElement("div", { className: "search-panel-scope-item", onClick: () => {
      onClose();
      navigate("/trade");
    } }, /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-name" }, "Trade catalog"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-meta" }, "Trade only")), /* @__PURE__ */ React.createElement("div", { className: "search-panel-scope-item", onClick: () => {
      onClose();
      navigate("/design-services");
    } }, /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-name" }, "Services"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-scope-meta" }, "Design & install"))))), /* @__PURE__ */ React.createElement("div", { className: "search-panel-footer" }, /* @__PURE__ */ React.createElement("div", { className: "search-panel-footer-keys" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u2191"), /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u2193"), " Navigate"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "\u21B5"), " Select"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("span", { className: "search-panel-kbd" }, "Esc"), " Close")), /* @__PURE__ */ React.createElement("span", { className: "search-panel-footer-action", onClick: () => {
      onClose();
      navigate("/shop");
    } }, "Search 2,400+ products")));
  }
  function Header({ goHome, goBrowse, cart, cartDrawerOpen, setCartDrawerOpen, cartFlash, onSearch, onSkuClick, tradeCustomer, onTradeClick, onTradeLogout, customer, onAccountClick, onCustomerLogout, wishlistCount, goWishlist, goCollections, categories, onCategorySelect, globalFacets, onAxisSelect, mobileNavOpen, setMobileNavOpen, mobileSearchOpen, setMobileSearchOpen, view, navigate, goSale }) {
    const [searchInput, setSearchInput] = useState("");
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
    useEffect(() => {
      fetch(API + "/api/storefront/search/popular").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((d) => setPopularSearches(d.terms || [])).catch(() => {
      });
    }, []);
    useEffect(() => {
      const handler = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") {
          e.preventDefault();
          if (searchInputRef.current) {
            searchInputRef.current.focus();
            setSearchOpen(true);
            setMegaOpen(null);
            clearTimeout(megaTimerRef.current);
            if (!searchInput && (popularSearches.length > 0 || recentSearches.length > 0)) setShowSuggestions(true);
          }
        }
        if (e.key === "Escape") {
          if (searchOpen) {
            setSearchOpen(false);
            setShowSuggestions(false);
            if (searchInputRef.current) searchInputRef.current.blur();
          } else if (megaOpen) {
            setMegaOpen(null);
          }
        }
      };
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }, [searchInput, popularSearches, recentSearches, megaOpen, searchOpen]);
    const openMegaPanel = (id) => {
      clearTimeout(megaTimerRef.current);
      setMegaOpen(id);
      setShowSuggestions(false);
      setSearchOpen(false);
    };
    const closeMegaPanel = () => {
      megaTimerRef.current = setTimeout(() => setMegaOpen(null), 140);
    };
    const suggestItems = useMemo(() => {
      const items = [];
      if (!searchInput) {
        recentSearches.forEach((t) => items.push({ type: "recent", data: { term: t } }));
        popularSearches.forEach((t) => items.push({ type: "popular", data: { term: t } }));
      } else {
        suggestData.categories.forEach((c) => items.push({ type: "category", data: c }));
        suggestData.collections.forEach((c) => items.push({ type: "collection", data: c }));
        suggestData.products.forEach((p) => items.push({ type: "product", data: p }));
      }
      return items;
    }, [suggestData, searchInput, recentSearches, popularSearches]);
    const fetchSuggestions = useCallback((q) => {
      clearTimeout(suggestTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
      if (!q || q.length < 2) {
        setSuggestData({ categories: [], collections: [], products: [], total: 0 });
        setShowSuggestions(false);
        setSuggestLoading(false);
        return;
      }
      setSuggestLoading(true);
      suggestTimerRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const res = await fetch(API + "/api/storefront/search/suggest?q=" + encodeURIComponent(q), { signal: controller.signal });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          if (!controller.signal.aborted) {
            setSuggestData(data);
            setShowSuggestions(true);
            setActiveIdx(-1);
            setSuggestLoading(false);
          }
        } catch (e) {
          if (e.name !== "AbortError") {
            setSuggestData({ categories: [], collections: [], products: [], total: 0 });
            setSuggestLoading(false);
          }
        }
      }, 300);
    }, []);
    const handleSearchInput = (e) => {
      preArrowInputRef.current = null;
      setActiveIdx(-1);
      setSearchInput(e.target.value);
      fetchSuggestions(e.target.value);
    };
    const selectSuggestion = (item) => {
      setShowSuggestions(false);
      setSearchOpen(false);
      setSearchInput("");
      setSuggestData({ categories: [], collections: [], products: [], total: 0 });
      if (item.type === "recent" || item.type === "popular") {
        addRecentSearch(item.data.term);
        setRecentSearches(getRecentSearches());
        onSearch(item.data.term);
      } else if (item.type === "category") {
        addRecentSearch(item.data.name);
        setRecentSearches(getRecentSearches());
        onCategorySelect(item.data.slug);
      } else if (item.type === "collection") {
        addRecentSearch(item.data.name);
        setRecentSearches(getRecentSearches());
        onSearch(item.data.name);
      } else if (item.type === "product") {
        addRecentSearch(item.data.product_name || item.data.collection);
        setRecentSearches(getRecentSearches());
        onSkuClick(item.data.sku_id, item.data.product_name || item.data.collection);
      }
    };
    const getItemLabel = (item) => {
      if (!item) return "";
      if (item.type === "recent" || item.type === "popular") return item.data.term;
      if (item.type === "category") return item.data.name;
      if (item.type === "collection") return item.data.name;
      if (item.type === "product") return fullProductName(item.data);
      return "";
    };
    const handleSearchKeyDown = (e) => {
      const totalItems = suggestItems.length;
      if (!showSuggestions && !searchOpen || totalItems === 0) {
        if (e.key === "Escape" && searchOpen) {
          setSearchOpen(false);
          setShowSuggestions(false);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (preArrowInputRef.current === null) preArrowInputRef.current = searchInput;
        setActiveIdx((i) => {
          const next = Math.min(i + 1, totalItems - 1);
          setSearchInput(getItemLabel(suggestItems[next]));
          return next;
        });
        setTimeout(() => {
          const el = searchWrapRef.current && searchWrapRef.current.querySelector(".active");
          if (el) el.scrollIntoView({ block: "nearest" });
        }, 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => {
          const next = Math.max(i - 1, -1);
          setSearchInput(next === -1 ? preArrowInputRef.current || "" : getItemLabel(suggestItems[next]));
          if (next === -1) preArrowInputRef.current = null;
          return next;
        });
        setTimeout(() => {
          const el = searchWrapRef.current && searchWrapRef.current.querySelector(".active");
          if (el) el.scrollIntoView({ block: "nearest" });
        }, 0);
      } else if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault();
        preArrowInputRef.current = null;
        selectSuggestion(suggestItems[activeIdx]);
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
        setSearchOpen(false);
        if (preArrowInputRef.current !== null) {
          setSearchInput(preArrowInputRef.current);
          preArrowInputRef.current = null;
        }
      }
    };
    useEffect(() => {
      const handleClickOutside = (e) => {
        if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
          const panel = e.target.closest(".search-panel");
          if (!panel) {
            setShowSuggestions(false);
            setSearchOpen(false);
          }
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);
    const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
    const shopColumns = useMemo(() => {
      const cols = [];
      parentCats.forEach((cat) => {
        const children = (cat.children || []).filter((ch) => ch.product_count > 0).sort((a, b) => b.product_count - a.product_count);
        const items = children.slice(0, 8).map((ch) => ({ name: ch.name, slug: ch.slug, count: ch.product_count || 0 }));
        items.push({ name: "View All", slug: cat.slug, count: cat.product_count || 0, isViewAll: true });
        cols.push({ title: cat.name, items });
      });
      return cols;
    }, [parentCats, categories]);
    const hasSuggestResults = suggestData.categories.length > 0 || suggestData.collections.length > 0 || suggestData.products.length > 0;
    let suggestItemIdx = 0;
    const searchForm = /* @__PURE__ */ React.createElement("form", { className: "header-search", ref: searchWrapRef, onSubmit: (e) => {
      e.preventDefault();
      const q = searchInput.trim();
      if (q) {
        addRecentSearch(q);
        setRecentSearches(getRecentSearches());
        onSearch(q);
        setShowSuggestions(false);
        setSearchOpen(false);
        setSearchInput("");
      }
    } }, /* @__PURE__ */ React.createElement("button", { type: "submit", className: "header-search-icon", tabIndex: -1, "aria-label": "Search" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), /* @__PURE__ */ React.createElement("input", { ref: searchInputRef, type: "text", placeholder: "Search products...", value: searchInput, autoComplete: "off", onChange: handleSearchInput, onKeyDown: handleSearchKeyDown, onFocus: () => {
      setMegaOpen(null);
      clearTimeout(megaTimerRef.current);
      setSearchOpen(true);
      if (hasSuggestResults || !searchInput && (popularSearches.length > 0 || recentSearches.length > 0)) setShowSuggestions(true);
    } }), searchInput && /* @__PURE__ */ React.createElement("button", { type: "button", className: "header-search-clear", onClick: () => {
      setSearchInput("");
      setSuggestData({ categories: [], collections: [], products: [], total: 0 });
      setShowSuggestions(false);
    }, "aria-label": "Clear search" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" }))), !searchInput && !searchOpen && /* @__PURE__ */ React.createElement("span", { className: "header-search-kbd" }, navigator.platform.indexOf("Mac") > -1 ? "\u2318K" : "Ctrl+K"));
    const NAV_ITEMS = [
      { id: "shop", label: "Shop", hasPanel: true, onClick: () => goBrowse() },
      { id: "services", label: "Services", hasPanel: true, onClick: () => navigate("/design-services") },
      { id: "materials", label: "Materials", hasPanel: true, onClick: () => goBrowse() },
      { id: "trade", label: "Trade", hasPanel: true, onClick: () => onTradeClick() },
      { id: "about", label: "About", hasPanel: false, onClick: () => navigate("/about") }
    ];
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("header", { onMouseLeave: () => setMegaOpen(null) }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar" }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar-inner" }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar-left" }, /* @__PURE__ */ React.createElement("span", null, "1440 S. State College Blvd Suite 6M"), /* @__PURE__ */ React.createElement("span", { className: "utility-bar-dot" }, "\u2022"), /* @__PURE__ */ React.createElement("span", null, "Anaheim, CA"), /* @__PURE__ */ React.createElement("span", { className: "utility-bar-dot" }, "\u2022"), /* @__PURE__ */ React.createElement("span", null, "Mon\u2013Fri 9\u20135 \xB7 Sat 10\u20135")), /* @__PURE__ */ React.createElement("div", { className: "utility-bar-right" }, /* @__PURE__ */ React.createElement("a", { href: "tel:+17149990009", className: "utility-bar-phone" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" })), "(714) 999-0009")))), /* @__PURE__ */ React.createElement("div", { className: "header-main" }, /* @__PURE__ */ React.createElement("div", { className: "header-main-left" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-menu-btn", "aria-label": "Open navigation menu", onClick: () => setMobileNavOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "18", x2: "21", y2: "18" }))), /* @__PURE__ */ React.createElement("div", { className: "logo", onClick: goHome }, /* @__PURE__ */ React.createElement("span", { className: "logo-text" }, "R O M A ", /* @__PURE__ */ React.createElement("em", null, "Flooring")))), /* @__PURE__ */ React.createElement("nav", { className: "header-nav" }, NAV_ITEMS.map((item) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: item.id,
        className: "header-nav-btn" + (megaOpen === item.id ? " active" : ""),
        onMouseEnter: () => {
          if (item.hasPanel) openMegaPanel(item.id);
          else {
            setMegaOpen(null);
            setSearchOpen(false);
            setShowSuggestions(false);
          }
        },
        onClick: () => {
          setMegaOpen(null);
          setSearchOpen(false);
          setShowSuggestions(false);
          item.onClick();
        }
      },
      item.label
    ))), /* @__PURE__ */ React.createElement("div", { className: "header-main-right" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-search-btn", "aria-label": "Search products", onClick: () => setMobileSearchOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), searchForm, /* @__PURE__ */ React.createElement("button", { className: "header-action-btn", onClick: onAccountClick, "aria-label": "Account", title: customer ? customer.first_name : "Account" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" }))), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn wishlist-header-wrap", "aria-label": "Wishlist", onClick: goWishlist }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), wishlistCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "wishlist-badge" }, wishlistCount)), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn" + (cartFlash ? " cart-flash" : ""), "aria-label": "Shopping cart", onClick: () => setCartDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), itemCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "cart-badge" }, itemCount)))), megaOpen && /* @__PURE__ */ React.createElement(
      MegaPanel,
      {
        panelId: megaOpen,
        categories,
        onCategorySelect: (slug) => {
          setMegaOpen(null);
          onCategorySelect(slug);
        },
        onTradeClick: () => {
          setMegaOpen(null);
          onTradeClick();
        },
        navigate: (path) => {
          setMegaOpen(null);
          navigate(path);
        },
        shopColumns,
        onEnter: () => clearTimeout(megaTimerRef.current),
        onClose: closeMegaPanel
      }
    ), searchOpen && !megaOpen && /* @__PURE__ */ React.createElement(
      SearchPanel,
      {
        searchInput,
        parentCats,
        suggestData,
        suggestLoading,
        popularSearches,
        recentSearches,
        activeIdx,
        onSearch: (q) => {
          setSearchOpen(false);
          setShowSuggestions(false);
          setSearchInput("");
          onSearch(q);
        },
        onCategorySelect,
        onSkuClick,
        onClose: () => {
          setSearchOpen(false);
          setShowSuggestions(false);
        },
        selectSuggestion,
        tradeCustomer,
        hasSuggestResults,
        suggestItems,
        navigate: (path) => {
          setSearchOpen(false);
          setShowSuggestions(false);
          navigate(path);
        }
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "mega-menu-scrim" + (megaOpen || searchOpen ? " visible" : ""), onClick: () => {
      setMegaOpen(null);
      setSearchOpen(false);
      setShowSuggestions(false);
    } }));
  }
  function CartDrawer({ cart, open, onClose, removeFromCart, goCart }) {
    const itemCount = cart.length;
    const productItems = cart.filter((i) => !i.is_sample);
    const sampleItems = cart.filter((i) => i.is_sample);
    const cartTotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0) + (sampleItems.length > 0 ? 12 : 0);
    useEffect(() => {
      document.body.style.overflow = open ? "hidden" : "";
      return () => {
        document.body.style.overflow = "";
      };
    }, [open]);
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Cart (", itemCount, ")"), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: onClose }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), itemCount === 0 ? /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-empty" }, "Your cart is empty") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-items" }, cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "cart-drawer-item" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-img" }, item.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image, 100), alt: "", decoding: "async", loading: "lazy", width: 40, height: 40 })), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-info" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-name" }, fullProductName(item) || "Product", item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "sample-tag" }, "Sample")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-meta" }, item.is_sample ? "FREE SAMPLE" : item.sell_by === "unit" ? `Qty: ${item.num_boxes}` : item.sell_by === "sqft" ? `${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft` : `${item.price_tier ? "" : item.num_boxes + " box" + (parseInt(item.num_boxes) !== 1 ? "es" : "") + " \xB7 "}${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft`, item.price_tier && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: item.price_tier === "roll" ? "var(--sage, #6b9080)" : "var(--stone-200)", color: item.price_tier === "roll" ? "white" : "var(--stone-600)" } }, item.price_tier === "roll" ? "Roll" : "Cut")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "cart-drawer-item-price" }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-item-remove", onClick: () => removeFromCart(item.id) }, "Remove")))))), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-footer" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, onClick: () => {
      onClose();
      goCart();
    } }, "View Cart & Checkout")))));
  }
  function QuickViewModal({ sku: initialSku, onClose, addToCart, onViewDetail }) {
    const [qty, setQty] = useState(1);
    const [activeSku, setActiveSku] = useState(initialSku);
    const [siblings, setSiblings] = useState([]);
    const [media, setMedia] = useState(initialSku.primary_image ? [{ url: initialSku.primary_image, asset_type: "primary" }] : []);
    const [imgIndex, setImgIndex] = useState(0);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState(false);
    const [adding, setAdding] = useState(false);
    const baseMediaRef = useRef(media);
    const isUnit = isSoldPerUnit(activeSku);
    const applyDetail = (data) => {
      if (data.redirect_to_sku || data.error || !data.sku) return;
      setActiveSku(data.sku);
      const allMedia = (data.media || []).filter((m) => m.url);
      const resolved = allMedia.length > 0 ? allMedia : data.sku.primary_image ? [{ url: data.sku.primary_image, asset_type: "primary" }] : [];
      setMedia(resolved);
      baseMediaRef.current = resolved;
      setImgIndex(0);
      const colorSiblings = (data.same_product_siblings || []).filter((s) => s.variant_type !== "accessory").sort((a, b) => (a.variant_name || "").localeCompare(b.variant_name || ""));
      setSiblings(colorSiblings);
    };
    const getTradeHeaders = () => {
      const t = localStorage.getItem("trade_token");
      return t ? { "X-Trade-Token": t } : {};
    };
    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setFetchError(false);
      fetch("/api/storefront/skus/" + initialSku.sku_id, { headers: getTradeHeaders() }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        if (!cancelled) applyDetail(data);
      }).catch((err) => {
        console.error("QuickView fetch error:", err);
        if (!cancelled) setFetchError(true);
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }, [initialSku.sku_id]);
    useEffect(() => {
      const handleKey = (e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowLeft") setImgIndex((i) => Math.max(0, i - 1));
        else if (e.key === "ArrowRight") setImgIndex((i) => media.length > 0 ? Math.min(i + 1, media.length - 1) : 0);
      };
      document.addEventListener("keydown", handleKey);
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", handleKey);
        document.body.style.overflow = "";
      };
    }, [media.length]);
    const qvIsOutOfStock = activeSku.stock_status === "out_of_stock" && activeSku.vendor_has_inventory !== false;
    const handleAdd = () => {
      if (adding || qvIsOutOfStock) return;
      setAdding(true);
      if (isUnit) {
        addToCart({ sku_id: activeSku.sku_id, num_boxes: qty, sell_by: "unit" });
      }
      onClose();
    };
    const handleVariantHover = (sib) => {
      setMedia([{ url: sib.primary_image, asset_type: "primary" }]);
      setImgIndex(0);
    };
    const handleVariantLeave = () => {
      setMedia(baseMediaRef.current);
      setImgIndex(0);
    };
    const handleVariantClick = (sib) => {
      setActiveSku((prev) => ({ ...prev, sku_id: sib.sku_id, variant_name: sib.variant_name, retail_price: sib.retail_price, cut_price: sib.cut_price, primary_image: sib.primary_image, sell_by: sib.sell_by, price_basis: sib.price_basis, sqft_per_box: sib.sqft_per_box }));
      fetch("/api/storefront/skus/" + sib.sku_id, { headers: getTradeHeaders() }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => applyDetail(data));
    };
    const currentImg = media[imgIndex] || {};
    const catName = activeSku.category_name || "";
    const vendorLabel = activeSku.brand_name || activeSku.vendor_name || "";
    const effectivePrice = displayPrice(activeSku, activeSku.trade_price || activeSku.sale_price || skuListPrice(activeSku) || 0);
    const sqftBox = parseFloat(activeSku.sqft_per_box) || 0;
    const boxPrice = sqftBox > 0 && !isUnit ? effectivePrice * sqftBox : 0;
    const allSwatches = siblings.length > 0 ? [
      { sku_id: activeSku.sku_id, variant_name: activeSku.variant_name, primary_image: (baseMediaRef.current[0] || {}).url, _isCurrent: true },
      ...siblings.filter((s) => s.sku_id !== activeSku.sku_id)
    ].sort((a, b) => (a.variant_name || "").localeCompare(b.variant_name || "")) : [];
    const specItems = [];
    const specKeys = ["species", "width", "finish", "material"];
    (activeSku.attributes || []).forEach((attr) => {
      if (specKeys.includes(attr.slug) && attr.value) specItems.push({ label: attr.name || attr.slug, value: attr.value });
    });
    if (specItems.length < 4 && catName) specItems.push({ label: "Category", value: catName });
    return /* @__PURE__ */ React.createElement("div", { className: "quick-view-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "quick-view", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "quick-view-close", onClick: onClose, "aria-label": "Close" }, "\xD7"), fetchError ? /* @__PURE__ */ React.createElement("div", { className: "qv-error-state" }, /* @__PURE__ */ React.createElement("p", { className: "qv-error-text" }, "Unable to load product details."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-outline", onClick: onClose }, "Close")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "quick-view-gallery" }, /* @__PURE__ */ React.createElement("div", { className: "quick-view-main-image" }, media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow left", disabled: imgIndex === 0, onClick: () => setImgIndex((i) => i - 1) }, "\u2039"), currentImg.url && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(currentImg.url, 800), ...optimizeSrcSet(currentImg.url, [400, 600, 800]), sizes: "(max-width: 768px) 90vw, 540px", alt: activeSku.product_name, decoding: "async", width: 540, height: 540 }), media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow right", disabled: imgIndex >= media.length - 1, onClick: () => setImgIndex((i) => i + 1) }, "\u203A"), media.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-img-counter" }, String(imgIndex + 1).padStart(2, "0"), " / ", String(media.length).padStart(2, "0"))), media.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-thumbstrip" }, media.map((m, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "quick-view-thumb" + (i === imgIndex ? " active" : ""), onClick: () => setImgIndex(i) }, m.url && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(m.url, 160), alt: "", decoding: "async", width: 80, height: 72 }))))), /* @__PURE__ */ React.createElement("div", { className: "quick-view-info" }, /* @__PURE__ */ React.createElement("div", { className: "qv-eyebrow" }, /* @__PURE__ */ React.createElement("span", { className: "qv-eyebrow-cat" }, catName, vendorLabel ? " \xB7 " + vendorLabel : ""), /* @__PURE__ */ React.createElement("span", { className: "qv-eyebrow-stock" }, isUnit ? "Accessory" : "Flooring")), /* @__PURE__ */ React.createElement("h2", null, fullProductName(activeSku)), activeSku.variant_name && /* @__PURE__ */ React.createElement("div", { className: "qv-variant-label" }, formatVariantName(activeSku.variant_name), activeSku.sku_code ? " \xB7 SKU " + activeSku.sku_code : ""), specItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "qv-specs-grid" }, specItems.slice(0, 4).map((sp, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "qv-spec-item" }, /* @__PURE__ */ React.createElement("div", { className: "qv-spec-label" }, sp.label), /* @__PURE__ */ React.createElement("div", { className: "qv-spec-value" }, sp.value)))), /* @__PURE__ */ React.createElement("div", { className: "qv-price-block" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "qv-price-amount" }, activeSku.trade_price && skuListPrice(activeSku) && /* @__PURE__ */ React.createElement("span", { className: "qv-price-original" }, "$", displayPrice(activeSku, skuListPrice(activeSku)).toFixed(2)), !activeSku.trade_price && activeSku.sale_price && skuListPrice(activeSku) && /* @__PURE__ */ React.createElement("span", { className: "qv-price-original" }, "$", displayPrice(activeSku, skuListPrice(activeSku)).toFixed(2)), "$", effectivePrice.toFixed(2), /* @__PURE__ */ React.createElement("span", { className: "qv-price-suffix" }, priceSuffix(activeSku)), !activeSku.trade_price && activeSku.sale_price && parseFloat(skuListPrice(activeSku)) > 0 && /* @__PURE__ */ React.createElement("span", { className: "qv-sale-tag" }, Math.round((1 - parseFloat(activeSku.sale_price) / parseFloat(skuListPrice(activeSku))) * 100), "% off")), activeSku.trade_price && /* @__PURE__ */ React.createElement("div", { className: "qv-price-note" }, "Trade pricing applied")), sqftBox > 0 && !isUnit && /* @__PURE__ */ React.createElement("div", { className: "qv-price-right" }, "Boxed at ", /* @__PURE__ */ React.createElement("strong", null, sqftBox.toFixed(1), " sf"), /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("span", { className: "qv-box-price" }, "$", boxPrice.toFixed(2), " / box"))), allSwatches.length > 0 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "quick-view-variants-header" }, /* @__PURE__ */ React.createElement("span", null, "Colorway \xB7 ", allSwatches.length, " options"), /* @__PURE__ */ React.createElement("span", { className: "qv-current-variant" }, formatVariantName(activeSku.variant_name))), /* @__PURE__ */ React.createElement("div", { className: "quick-view-variants" }, allSwatches.map((sib) => /* @__PURE__ */ React.createElement(
      "div",
      {
        key: sib.sku_id,
        className: "quick-view-variant-swatch" + (sib._isCurrent ? " active" : ""),
        title: formatVariantName(sib.variant_name),
        onMouseEnter: () => !sib._isCurrent && handleVariantHover(sib),
        onMouseLeave: () => !sib._isCurrent && handleVariantLeave(),
        onClick: () => !sib._isCurrent && handleVariantClick(sib)
      },
      sib.primary_image ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sib.primary_image, 120), alt: sib.variant_name, decoding: "async", width: 44, height: 44 }) : /* @__PURE__ */ React.createElement("div", { className: "qv-swatch-placeholder" }, formatVariantName(sib.variant_name))
    )))), activeSku.description_short && /* @__PURE__ */ React.createElement("p", { className: "qv-description" }, activeSku.description_short), activeSku.stock_status && activeSku.stock_status !== "unknown" && /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(StockBadge, { status: activeSku.stock_status, vendorHasInventory: activeSku.vendor_has_inventory, qtyOnHand: activeSku.qty_on_hand, qtyOnHandSqft: activeSku.qty_on_hand_sqft, sellBy: activeSku.sell_by })), isUnit ? /* @__PURE__ */ React.createElement("div", { className: "quick-view-actions" }, !qvIsOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "qv-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => Math.max(1, q - 1)) }, "\u2212"), /* @__PURE__ */ React.createElement("div", { className: "qv-qty-display" }, qty), /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => q + 1) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "qv-btn-primary", onClick: qvIsOutOfStock ? void 0 : handleAdd, disabled: qvIsOutOfStock }, qvIsOutOfStock ? "Out of Stock" : "Add to cart" + (qty > 1 ? " \xB7 $" + (effectivePrice * qty).toFixed(2) : "")), /* @__PURE__ */ React.createElement("button", { className: "qv-btn-secondary", onClick: () => {
      onViewDetail(activeSku.sku_id, activeSku.product_name);
      onClose();
    } }, "Order sample")) : /* @__PURE__ */ React.createElement("div", { className: "quick-view-actions qv-sqft-actions" }, /* @__PURE__ */ React.createElement("button", { className: "qv-btn-primary", onClick: () => {
      onViewDetail(activeSku.sku_id, activeSku.product_name);
      onClose();
    } }, "Calculate coverage"), /* @__PURE__ */ React.createElement("button", { className: "qv-btn-secondary", onClick: () => {
      onViewDetail(activeSku.sku_id, activeSku.product_name);
      onClose();
    } }, "Order sample")), /* @__PURE__ */ React.createElement("div", { className: "qv-footer" }, /* @__PURE__ */ React.createElement("div", { className: "qv-footer-links" }, /* @__PURE__ */ React.createElement("button", { className: "qv-footer-link", onClick: () => {
      if (typeof toggleWishlist === "function") toggleWishlist(activeSku.sku_id);
    }, title: "Save to wishlist" }, /* @__PURE__ */ React.createElement("span", { className: "qv-link-icon" }, "\u2661"), " Save")), /* @__PURE__ */ React.createElement("button", { className: "qv-detail-link", onClick: () => {
      onViewDetail(activeSku.sku_id, activeSku.product_name);
      onClose();
    } }, "View full details \u2192"))))));
  }
  function MobileNav({ open, onClose, categories, onCategorySelect, globalFacets, onAxisSelect, goHome, goBrowse, goCollections, goTrade, goAccount, customer, tradeCustomer, onTradeClick, onCustomerLogout, onTradeLogout }) {
    const [expandedCat, setExpandedCat] = useState(null);
    const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
    useEffect(() => {
      document.body.style.overflow = open ? "hidden" : "";
      return () => {
        document.body.style.overflow = "";
      };
    }, [open]);
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("nav", { className: "mobile-nav" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-head" }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-heading)", fontSize: "1.25rem", fontWeight: 600 } }, "Menu"), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", fontSize: "1.5rem", color: "var(--stone-500)", cursor: "pointer" } }, "\xD7")), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-links" }, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goHome();
      onClose();
    } }, "Home"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goBrowse();
      onClose();
    } }, "Shop All"), parentCats.map((cat) => {
      const children = categories.filter((c) => c.parent_id === cat.id);
      if (children.length === 0) {
        return /* @__PURE__ */ React.createElement("a", { key: cat.id, href: "#", onClick: (e) => {
          e.preventDefault();
          onCategorySelect(cat.slug);
          onClose();
        } }, cat.name);
      }
      return /* @__PURE__ */ React.createElement("div", { key: cat.id, className: "mobile-nav-cat-item" }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-cat-header", onClick: () => setExpandedCat(expandedCat === cat.id ? null : cat.id) }, /* @__PURE__ */ React.createElement("span", null, cat.name), /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16, transform: expandedCat === cat.id ? "rotate(180deg)" : "none", transition: "transform 0.2s" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))), expandedCat === cat.id && /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-cat-children" }, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
        e.preventDefault();
        onCategorySelect(cat.slug);
        onClose();
      } }, "All ", cat.name), children.map((child) => /* @__PURE__ */ React.createElement("a", { key: child.id, href: "#", onClick: (e) => {
        e.preventDefault();
        onCategorySelect(child.slug);
        onClose();
      } }, child.name))));
    }), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goCollections();
      onClose();
    } }, "Collections")), !tradeCustomer && /* @__PURE__ */ React.createElement("a", { className: "mobile-nav-trade-cta", href: "#", onClick: (e) => {
      e.preventDefault();
      onTradeClick();
      onClose();
    } }, "Trade Program"), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-footer" }, customer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Signed in as ", customer.first_name || customer.email), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goAccount();
      onClose();
    } }, "My Account"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      onCustomerLogout();
      onClose();
    } }, "Sign Out")) : tradeCustomer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Trade: ", tradeCustomer.company_name), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goTrade();
      onClose();
    } }, "Trade Dashboard"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      onTradeLogout();
      onClose();
    } }, "Sign Out")) : /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goAccount();
      onClose();
    } }, "Sign In")))));
  }
  function MobileSearchOverlay({ open, onClose, onSearch, onSkuClick, onCategorySelect }) {
    const [query, setQuery] = useState("");
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
        fetch(API + "/api/storefront/search/popular").then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => setMobilePopular(d.terms || [])).catch(() => {
        });
      }
      if (!open) {
        setQuery("");
        setSuggestData({ categories: [], collections: [], products: [], total: 0 });
      }
    }, [open]);
    useEffect(() => {
      if (!query || query.length < 2) {
        setSuggestData({ categories: [], collections: [], products: [], total: 0 });
        return;
      }
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const res = await fetch(API + "/api/storefront/search/suggest?q=" + encodeURIComponent(query));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          setSuggestData(data);
        } catch (e) {
          setSuggestData({ categories: [], collections: [], products: [], total: 0 });
        }
        setLoading(false);
      }, 250);
      return () => clearTimeout(debounceRef.current);
    }, [query]);
    const handleSubmit = (e) => {
      e.preventDefault();
      if (query.trim()) {
        addRecentSearch(query.trim());
        setMobileRecent(getRecentSearches());
        onSearch(query.trim());
        onClose();
      }
    };
    const hasResults = suggestData.categories.length > 0 || suggestData.collections.length > 0 || suggestData.products.length > 0;
    return open ? /* @__PURE__ */ React.createElement("div", { className: "mobile-search-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "mobile-search-header" }, /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { flex: 1, display: "flex", gap: "0.5rem", position: "relative" } }, /* @__PURE__ */ React.createElement("input", { ref: inputRef, className: "mobile-search-input", type: "text", placeholder: "Search products...", value: query, autoComplete: "off", onChange: (e) => setQuery(e.target.value) }), query && /* @__PURE__ */ React.createElement("button", { type: "button", className: "header-search-clear", style: { position: "absolute", right: "0.5rem", top: "50%", transform: "translateY(-50%)" }, onClick: () => {
      setQuery("");
      setSuggestData({ categories: [], collections: [], products: [], total: 0 });
    }, "aria-label": "Clear search" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), /* @__PURE__ */ React.createElement("button", { className: "mobile-search-close", onClick: onClose }, "Cancel")), !query && (mobileRecent.length > 0 || mobilePopular.length > 0) && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, mobileRecent.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Recent Searches", /* @__PURE__ */ React.createElement("button", { className: "search-recent-clear", onClick: () => {
      clearRecentSearches();
      setMobileRecent([]);
    } }, "Clear")), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-popular" }, mobileRecent.map((term) => /* @__PURE__ */ React.createElement("div", { key: term, className: "search-suggest-popular-item", onClick: () => {
      addRecentSearch(term);
      setMobileRecent(getRecentSearches());
      onSearch(term);
      onClose();
    } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("polyline", { points: "12 6 12 12 16 14" })), term)))), mobilePopular.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Popular Searches"), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-popular" }, mobilePopular.map((term) => /* @__PURE__ */ React.createElement("div", { key: term, className: "search-suggest-popular-item", onClick: () => {
      addRecentSearch(term);
      setMobileRecent(getRecentSearches());
      onSearch(term);
      onClose();
    } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "23 6 13.5 15.5 8.5 10.5 1 18" }), /* @__PURE__ */ React.createElement("polyline", { points: "17 6 23 6 23 12" })), term))))), !hasResults && !loading && query && query.length >= 2 && (suggestData.didYouMean || suggestData.autoCorrect) && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, suggestData.autoCorrect ? /* @__PURE__ */ React.createElement("div", { className: "search-autocorrect-banner" }, "Showing results for ", /* @__PURE__ */ React.createElement("strong", null, suggestData.autoCorrect.correctedQuery), ".", " ", /* @__PURE__ */ React.createElement("button", { className: "search-autocorrect-link", onClick: () => setQuery(query) }, "Search instead for \u201C", query, "\u201D")) : /* @__PURE__ */ React.createElement("div", { className: "search-did-you-mean", onClick: () => {
      setQuery(suggestData.didYouMean);
    } }, "Did you mean: ", /* @__PURE__ */ React.createElement("strong", null, suggestData.didYouMean), "?"))), hasResults && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, suggestData.expandedFrom && /* @__PURE__ */ React.createElement("div", { className: "search-expanded-indicator" }, "Showing results for ", /* @__PURE__ */ React.createElement("strong", null, suggestData.expandedTo ? suggestData.expandedTo.split(" ").slice(0, 4).join(" ") : suggestData.expandedFrom)), suggestData.categories.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Categories"), suggestData.categories.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "search-suggest-item", onClick: () => {
      addRecentSearch(cat.name);
      onCategorySelect(cat.slug);
      onClose();
    } }, /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, cat.image_url ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(cat.image_url, 80), alt: "", decoding: "async", loading: "lazy", width: 32, height: 32, style: { borderRadius: 3, objectFit: "cover" } }) : /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" }))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-category-text" }, highlightMatch(cat.name, query)), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, cat.product_count)))), suggestData.collections.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Collections"), suggestData.collections.map((col) => /* @__PURE__ */ React.createElement("div", { key: col.name, className: "search-suggest-item", onClick: () => {
      addRecentSearch(col.name);
      onSearch(col.name);
      onClose();
    } }, col.image ? /* @__PURE__ */ React.createElement("img", { className: "search-suggest-collection-img", onLoad: handleProductImgLoad, src: optimizeImg(col.image, 100), alt: "", decoding: "async", loading: "lazy", width: 48, height: 48 }) : /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" }))), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-name" }, highlightMatch(col.name, query))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, col.product_count)))), suggestData.products.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Products"), suggestData.products.map((sku) => {
      const colorInfo = sku.color_family;
      return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "mobile-search-result", onClick: () => {
        addRecentSearch(sku.product_name || sku.collection);
        onSkuClick(sku.sku_id, sku.product_name);
        onClose();
      } }, /* @__PURE__ */ React.createElement("div", { className: "mobile-search-result-img mobile-search-result-img--lg" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 120), alt: "", decoding: "async", loading: "lazy", width: 56, height: 56 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, fontSize: "0.875rem" } }, highlightMatch(fullProductName(sku), query)), /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-vendor" }, colorInfo && colorInfo.hex && /* @__PURE__ */ React.createElement("span", { className: "search-panel-color-dot", style: { background: colorInfo.hex }, title: colorInfo.family }), sku.brand_name || sku.vendor_name || ""), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, sku.sale_price && /* @__PURE__ */ React.createElement("span", { className: "search-panel-sale-tag" }, "SALE"), "$", displayPrice(sku, skuListPrice(sku)).toFixed(2), priceSuffix(sku))));
    })), suggestData.total > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-footer", onClick: () => {
      const q = query.trim();
      if (q) {
        addRecentSearch(q);
      }
      onSearch(q);
      onClose();
    } }, "View all ", suggestData.total, " results")), loading && /* @__PURE__ */ React.createElement("div", { style: { padding: "0.5rem 1rem" } }, [0, 1, 2, 3].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-search-result", style: { animationDelay: i * 0.1 + "s" } }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-img", style: { width: 56, height: 56 } }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-lines" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short", style: { marginTop: 0 } }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar", style: { width: 40, height: 10 } }))))) : null;
  }
  function HomePage({ featuredSkus, featuredLoading, categories, onSkuClick, onCategorySelect, goBrowse, goTrade, goCabinets, navigate, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku, newsletterEmail, setNewsletterEmail, newsletterSubmitted, onNewsletterSubmit, onOpenQuiz }) {
    const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
    const cabinetImages = parentCats.slice(0, 3).map((c) => c.image_url).filter(Boolean);
    const specimens = featuredSkus.slice(0, 3);
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("section", { className: "form-hero" }, /* @__PURE__ */ React.createElement("div", { className: "form-hero-inner" }, /* @__PURE__ */ React.createElement("div", { className: "form-eyebrow" }, "Flooring & Surfaces \xB7 Anaheim, est. 1999"), /* @__PURE__ */ React.createElement("h1", { className: "form-hero-headline" }, "Premium surfaces for the spaces that shape how you live"), /* @__PURE__ */ React.createElement("button", { className: "form-hero-cta", onClick: goBrowse }, "Browse the catalog"))), /* @__PURE__ */ React.createElement(RevealSection, null, /* @__PURE__ */ React.createElement("section", { className: "form-cabinet-band" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-inner" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-images" }, /* @__PURE__ */ React.createElement("img", { src: optimizeImg("/uploads/homepage/cabinet-1.jpg", 500), alt: "Maple Cider and Painted Sage kitchen", loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("img", { src: optimizeImg("/uploads/homepage/cabinet-2.jpg", 500), alt: "Navy island with Maple Cider uppers", loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("img", { src: optimizeImg("/uploads/homepage/cabinet-3.jpg", 500), alt: "Maple Cider and Painted Vanilla kitchen", loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-content" }, /* @__PURE__ */ React.createElement("div", { className: "form-eyebrow" }, "Custom Cabinetry"), /* @__PURE__ */ React.createElement("h2", { className: "form-cabinet-headline" }, "Cabinets, built to ", /* @__PURE__ */ React.createElement("em", null, "the room")), /* @__PURE__ */ React.createElement("p", { className: "form-cabinet-body" }, "Every kitchen and bath is different. Our cabinetry program pairs premium materials with made-to-measure construction so nothing is compromised."), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stats" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-value" }, "4"), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-label" }, "Brands")), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-value" }, "86"), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-label" }, "Door styles")), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat" }, /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-value" }, "140+"), /* @__PURE__ */ React.createElement("div", { className: "form-cabinet-stat-label" }, "Colors"))), /* @__PURE__ */ React.createElement("button", { className: "form-cabinet-link", onClick: goCabinets }, "Explore cabinetry \u2192"))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "form-section" }, /* @__PURE__ */ React.createElement("div", { className: "form-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "form-eyebrow" }, "Featured This Season"), /* @__PURE__ */ React.createElement("h2", { className: "form-section-headline" }, "Selected specimens")), featuredLoading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 3 }) : specimens.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "form-specimen-grid" }, specimens.map((sku, i) => {
      const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
      const price = sku.trade_price || sku.sale_price || basePrice;
      return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "form-specimen-card", onClick: () => onSkuClick(sku.sku_id, sku.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-image" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 600), alt: sku.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-meta" }, "No. ", String(i + 1).padStart(2, "0"), " \xB7 ", sku.category_name || "Flooring"), price && /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-price" }, "$", displayPrice(sku, price).toFixed(2), priceSuffix(sku)), /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-name" }, fullProductName(sku)), /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-desc" }, sku.brand_name || sku.vendor_name, sku.variant_name ? " \xB7 " + sku.variant_name : ""), /* @__PURE__ */ React.createElement("div", { className: "form-specimen-card-cta" }, "View in catalog \u2192"));
    })) : /* @__PURE__ */ React.createElement("p", { className: "featured-empty" }, "Featured products coming soon."))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "form-counsel-band" }, /* @__PURE__ */ React.createElement("div", { className: "form-counsel-inner" }, /* @__PURE__ */ React.createElement("h2", { className: "form-counsel-headline" }, "We send free samples anywhere in the country"), /* @__PURE__ */ React.createElement("p", { className: "form-counsel-body" }, "Choose up to five materials and we will ship them to your door at no cost. Touch the grain, see the color in your own light, then decide."), /* @__PURE__ */ React.createElement("div", { className: "form-counsel-actions" }, /* @__PURE__ */ React.createElement("button", { className: "form-counsel-btn form-counsel-btn-light", onClick: goBrowse }, "Build a sample box"), /* @__PURE__ */ React.createElement("button", { className: "form-counsel-btn form-counsel-btn-outline", onClick: () => navigate("/about") }, "Visit the showroom"))))));
  }
  function SearchEmptyState({ searchQuery, categories, onSearch, onCategorySelect, didYouMean, popularTerms }) {
    const fallbackTerms = ["porcelain tile", "hardwood", "luxury vinyl", "mosaic", "marble", "carpet"];
    const suggestedTerms = popularTerms && popularTerms.length > 0 ? popularTerms.slice(0, 6) : fallbackTerms;
    return /* @__PURE__ */ React.createElement("div", { className: "search-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })), /* @__PURE__ */ React.createElement("h2", null, 'No results for "', searchQuery, '"'), didYouMean && /* @__PURE__ */ React.createElement("p", { className: "search-empty-did-you-mean" }, "Did you mean: ", /* @__PURE__ */ React.createElement("button", { className: "search-empty-dym-link", onClick: () => onSearch(didYouMean) }, didYouMean), "?"), /* @__PURE__ */ React.createElement("p", null, "We couldn't find any products matching your search. Try one of these:"), /* @__PURE__ */ React.createElement("div", { className: "search-empty-suggestions" }, suggestedTerms.map((term) => /* @__PURE__ */ React.createElement("button", { key: term, className: "search-empty-chip", onClick: () => onSearch(term) }, term))), /* @__PURE__ */ React.createElement("p", { className: "search-empty-browse" }, "Or browse by category:"), /* @__PURE__ */ React.createElement("div", { className: "search-empty-categories" }, categories.filter((c) => !c.parent_id && c.product_count > 0).slice(0, 6).map((cat) => /* @__PURE__ */ React.createElement("button", { key: cat.slug, className: "search-empty-cat-chip", onClick: () => onCategorySelect(cat.slug) }, cat.name))));
  }
  function ShopLanding({ categories, featuredSkus, featuredLoading, onCategorySelect, onSkuClick, goTrade, navigate }) {
    const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
    const heroCats = parentCats.slice(0, 2);
    const gridCats = parentCats.slice(2, 6);
    const totalProducts = categories.reduce((s, c) => s + (c.product_count || 0), 0);
    const featured = featuredSkus.slice(0, 6);
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("section", { className: "shop-landing-hero" }, /* @__PURE__ */ React.createElement("div", { className: "shop-landing-hero-inner" }, /* @__PURE__ */ React.createElement("div", { className: "shop-landing-hero-left" }, /* @__PURE__ */ React.createElement("div", { className: "form-eyebrow" }, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("h1", { className: "shop-landing-hero-headline" }, "The catalog.")), /* @__PURE__ */ React.createElement("div", { className: "shop-landing-hero-right" }, /* @__PURE__ */ React.createElement("p", { className: "shop-landing-hero-intro" }, "Every surface we carry has been tested, graded, and selected by our materials team. Browse by category, compare specimens side by side, and order samples shipped free."), /* @__PURE__ */ React.createElement("div", { className: "shop-landing-hero-actions" }, /* @__PURE__ */ React.createElement("button", { className: "shop-landing-hero-btn", onClick: () => navigate("/shop?category=tile") }, "Order samples"), /* @__PURE__ */ React.createElement("button", { className: "shop-landing-hero-link", onClick: () => navigate("/about") }, "Book a showroom visit")), /* @__PURE__ */ React.createElement("div", { className: "shop-landing-stat" }, /* @__PURE__ */ React.createElement("strong", null, totalProducts.toLocaleString()), " products across ", /* @__PURE__ */ React.createElement("strong", null, parentCats.length), " categories")))), parentCats.length > 0 && /* @__PURE__ */ React.createElement(RevealSection, null, /* @__PURE__ */ React.createElement("section", { className: "shop-landing-section" }, /* @__PURE__ */ React.createElement("div", { className: "shop-landing-section-header" }, /* @__PURE__ */ React.createElement("span", { className: "shop-landing-section-num" }, "01"), /* @__PURE__ */ React.createElement("h2", { className: "shop-landing-section-title" }, "Shop by material")), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-mosaic" }, /* @__PURE__ */ React.createElement("div", { className: "shop-cat-heroes" }, heroCats.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "shop-cat-card shop-cat-card-hero", onClick: () => onCategorySelect(cat.slug) }, cat.image_url && /* @__PURE__ */ React.createElement("img", { src: optimizeImg(cat.image_url, 600), alt: cat.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-count" }, cat.product_count, " products"), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-name" }, cat.name), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-cta" }, "Browse \u2192"))))), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-grid-right" }, gridCats.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "shop-cat-card shop-cat-card-std", onClick: () => onCategorySelect(cat.slug) }, cat.image_url && /* @__PURE__ */ React.createElement("img", { src: optimizeImg(cat.image_url, 400), alt: cat.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-count" }, cat.product_count, " products"), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-name" }, cat.name), /* @__PURE__ */ React.createElement("div", { className: "shop-cat-card-cta" }, "Browse \u2192")))))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "shop-landing-section" }, /* @__PURE__ */ React.createElement("div", { className: "shop-landing-section-header" }, /* @__PURE__ */ React.createElement("span", { className: "shop-landing-section-num" }, "02"), /* @__PURE__ */ React.createElement("h2", { className: "shop-landing-section-title" }, "Featured specimens")), featuredLoading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 6 }) : featured.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "shop-featured-grid" }, featured.map((sku) => {
      const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
      const price = sku.trade_price || sku.sale_price || basePrice;
      return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "shop-featured-card", onClick: () => onSkuClick(sku.sku_id, sku.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "shop-featured-card-image" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 500), alt: sku.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "shop-featured-card-cat" }, sku.category_name || "Flooring"), /* @__PURE__ */ React.createElement("div", { className: "shop-featured-card-name" }, fullProductName(sku)), /* @__PURE__ */ React.createElement("div", { className: "shop-featured-card-meta" }, sku.brand_name || sku.vendor_name, sku.variant_name ? " \xB7 " + sku.variant_name : ""), /* @__PURE__ */ React.createElement("div", { className: "shop-featured-card-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "shop-featured-card-price" }, price ? "$" + displayPrice(sku, price).toFixed(2) + priceSuffix(sku) : "Call for price"), /* @__PURE__ */ React.createElement("span", { className: "shop-featured-card-cta" }, "View \u2192")));
    })) : /* @__PURE__ */ React.createElement("p", { className: "featured-empty" }, "Featured products coming soon."))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "shop-trade-band" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-inner" }, /* @__PURE__ */ React.createElement("h2", { className: "shop-trade-headline" }, "Built for the trade"), /* @__PURE__ */ React.createElement("p", { className: "shop-trade-body" }, "Contractors, designers, and architects get exclusive pricing, dedicated account management, and tools built for commercial projects."), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefits" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "5" }))), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-label" }, "Tiered pricing")), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "3", width: "15", height: "13", rx: "1" }), /* @__PURE__ */ React.createElement("polyline", { points: "16 8 20 8 23 11 23 16 20 16" }), /* @__PURE__ */ React.createElement("circle", { cx: "18", cy: "18", r: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "18", r: "2" }))), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-label" }, "Free shipping")), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "9", cy: "7", r: "4" }), /* @__PURE__ */ React.createElement("path", { d: "M23 21v-2a4 4 0 00-3-3.87" }), /* @__PURE__ */ React.createElement("path", { d: "M16 3.13a4 4 0 010 7.75" }))), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-label" }, "Dedicated rep")), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit" }, /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "7", width: "20", height: "14", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M16 7V5a4 4 0 00-8 0v2" }))), /* @__PURE__ */ React.createElement("div", { className: "shop-trade-benefit-label" }, "Bulk samples"))), /* @__PURE__ */ React.createElement("button", { className: "shop-trade-cta", onClick: goTrade }, "Apply for trade access")))));
  }
  function CategoryHero({ category, crumbs, searchQuery, totalSkus, vendorCount }) {
    if (searchQuery) {
      return /* @__PURE__ */ React.createElement("div", { className: "category-header-editorial category-header-search" }, /* @__PURE__ */ React.createElement("div", { className: "cat-header-top" }, /* @__PURE__ */ React.createElement("div", { className: "cat-header-breadcrumb" }, crumbs.map((c, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, i > 0 && /* @__PURE__ */ React.createElement("span", { className: "cat-crumb-sep" }), c.onClick ? /* @__PURE__ */ React.createElement("a", { onClick: c.onClick }, c.label) : /* @__PURE__ */ React.createElement("span", { className: "cat-crumb-current" }, c.label)))), /* @__PURE__ */ React.createElement("div", { className: "cat-header-stats" }, totalSkus, " result", totalSkus !== 1 ? "s" : "")), /* @__PURE__ */ React.createElement("div", { className: "cat-header-body cat-header-body-search" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h1", { className: "cat-header-headline" }, totalSkus, " results for ", "\u2018", /* @__PURE__ */ React.createElement("em", null, searchQuery), "\u2019"))));
    }
    const catName = category ? category.name : "Shop All";
    const children = category && category.children ? category.children : [];
    const isParent = children.length > 0 && category && !category.parent_id;
    let kickerText = category ? `Material \xB7 ${catName}` : null;
    if (isParent && children.length > 0) {
      const childNames = children.map((ch) => ch.name).join(" & ").toUpperCase();
      kickerText = `Material \xB7 ${childNames} \xB7 ${totalSkus} Products`;
    }
    return /* @__PURE__ */ React.createElement("div", { className: "category-header-editorial" }, /* @__PURE__ */ React.createElement("div", { className: "cat-header-top" }, /* @__PURE__ */ React.createElement("div", { className: "cat-header-breadcrumb" }, crumbs.map((c, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, i > 0 && /* @__PURE__ */ React.createElement("span", { className: "cat-crumb-sep" }), c.onClick ? /* @__PURE__ */ React.createElement("a", { onClick: c.onClick }, c.label) : /* @__PURE__ */ React.createElement("span", { className: "cat-crumb-current" }, c.label)))), /* @__PURE__ */ React.createElement("div", { className: "cat-header-stats" }, totalSkus, " product", totalSkus !== 1 ? "s" : "")), /* @__PURE__ */ React.createElement("div", { className: "cat-header-body" }, /* @__PURE__ */ React.createElement("div", null, kickerText && /* @__PURE__ */ React.createElement("div", { className: "cat-header-kicker" }, kickerText), /* @__PURE__ */ React.createElement("h1", { className: "cat-header-headline" }, catName)), /* @__PURE__ */ React.createElement("div", { className: "cat-header-right" }, category && category.description && /* @__PURE__ */ React.createElement("p", { className: "cat-header-intro" }, category.description), isParent && /* @__PURE__ */ React.createElement("div", { className: "cat-header-facts" }, /* @__PURE__ */ React.createElement("div", { className: "cat-fact" }, /* @__PURE__ */ React.createElement("div", { className: "cat-fact-value" }, vendorCount || 0), /* @__PURE__ */ React.createElement("div", { className: "cat-fact-label" }, "Brands")), /* @__PURE__ */ React.createElement("div", { className: "cat-fact" }, /* @__PURE__ */ React.createElement("div", { className: "cat-fact-value" }, totalSkus), /* @__PURE__ */ React.createElement("div", { className: "cat-fact-label" }, "Products")), /* @__PURE__ */ React.createElement("div", { className: "cat-fact" }, /* @__PURE__ */ React.createElement("div", { className: "cat-fact-value" }, children.length), /* @__PURE__ */ React.createElement("div", { className: "cat-fact-label" }, "Sub-categories"))))));
  }
  function BrowseView({
    skus,
    totalSkus,
    loading,
    categories,
    selectedCategory,
    selectedCollection,
    searchQuery,
    onCategorySelect,
    onSearch,
    facets,
    filters,
    onFilterToggle,
    onBatchFilterSet,
    onClearFilters,
    sortBy,
    onSortChange,
    onSkuClick,
    currentPage,
    onPageChange,
    wishlist,
    toggleWishlist: toggleWishlist2,
    setQuickViewSku,
    filterDrawerOpen,
    setFilterDrawerOpen,
    goHome,
    vendorFacets,
    vendorFilters,
    onVendorToggle,
    priceRange,
    userPriceRange,
    onPriceRangeChange,
    tagFacets,
    tagFilters,
    onTagToggle,
    didYouMean,
    searchTimeMs,
    relatedSearches,
    matchingCategories
  }) {
    const [viewMode, setViewMode] = useState("grid");
    const totalPages = Math.ceil(totalSkus / 24);
    const hasAttrFilters = Object.keys(filters).length > 0;
    const hasVendorFilters = vendorFilters && vendorFilters.length > 0;
    const hasPriceFilters = userPriceRange && (userPriceRange.min != null || userPriceRange.max != null);
    const hasTagFilters = tagFilters && tagFilters.length > 0;
    const hasFilters = hasAttrFilters || hasVendorFilters || hasPriceFilters || hasTagFilters;
    const totalActiveFilterCount = (vendorFilters ? vendorFilters.length : 0) + (hasPriceFilters ? 1 : 0) + (tagFilters ? tagFilters.length : 0) + Object.values(filters).reduce((s, a) => s + a.length, 0);
    let currentCategory = null;
    let categoryName = null;
    if (selectedCategory) {
      const flat = [];
      categories.forEach((c) => {
        flat.push(c);
        (c.children || []).forEach((ch) => flat.push(ch));
      });
      currentCategory = flat.find((c) => c.slug === selectedCategory) || null;
      if (currentCategory) categoryName = currentCategory.name;
    }
    const crumbs = [{ label: "Home", onClick: goHome }, { label: "Shop", onClick: !selectedCategory && !selectedCollection && !searchQuery ? void 0 : () => onCategorySelect(null) }];
    if (categoryName) crumbs.push({ label: categoryName });
    else if (selectedCollection) crumbs.push({ label: selectedCollection });
    else if (searchQuery) crumbs.push({ label: "Search Results" });
    const facetProps = {
      facets,
      filters,
      onFilterToggle,
      onBatchFilterSet,
      onClearFilters,
      vendors: vendorFacets,
      vendorFilters,
      onVendorToggle,
      priceRange,
      userPriceRange,
      onPriceRangeChange,
      tagFacets,
      tagFilters,
      onTagToggle,
      totalSkus
    };
    const isParentLanding = currentCategory && !currentCategory.parent_id && !searchQuery && !selectedCollection;
    const landingChildren = isParentLanding ? (currentCategory.children || []).filter((ch) => ch.product_count > 0) : [];
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery, totalSkus, vendorCount: vendorFacets ? vendorFacets.length : 0 }), isParentLanding && landingChildren.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "subcategory-strip" }, /* @__PURE__ */ React.createElement("div", { className: "subcategory-strip-grid", style: { gridTemplateColumns: "repeat(" + Math.min(landingChildren.length, 6) + ", 1fr)" } }, landingChildren.map((child) => /* @__PURE__ */ React.createElement("div", { key: child.slug, className: "subcategory-strip-tile" + (selectedCategory === child.slug ? " active" : ""), onClick: () => onCategorySelect(child.slug) }, /* @__PURE__ */ React.createElement("div", { className: "subcategory-tile-bg" }, child.image_url ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(child.image_url, 300), alt: "", loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { className: "subcategory-strip-placeholder" })), /* @__PURE__ */ React.createElement("div", { className: "subcategory-tile-label" }, /* @__PURE__ */ React.createElement("span", { className: "subcategory-strip-name" }, child.name), /* @__PURE__ */ React.createElement("span", { className: "subcategory-strip-count" }, child.product_count)))))), /* @__PURE__ */ React.createElement("div", { className: "browse-layout" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar" }, /* @__PURE__ */ React.createElement(FacetPanel, { ...facetProps })), /* @__PURE__ */ React.createElement("div", { className: "browse-content" }, hasFilters && /* @__PURE__ */ React.createElement(
      ActiveFilterPills,
      {
        filters,
        facets,
        onFilterToggle,
        onClearFilters,
        vendorFilters,
        onVendorToggle,
        userPriceRange,
        onPriceRangeChange,
        tagFilters,
        tagFacets,
        onTagToggle
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "browse-toolbar-row" }, /* @__PURE__ */ React.createElement(BrowseToolbar, { totalSkus, sortBy, onSortChange, currentPage, viewMode, onViewModeChange: setViewMode, searchQuery, searchTimeMs, relatedSearches, onSearch, matchingCategories, onCategorySelect }), /* @__PURE__ */ React.createElement("button", { className: "mobile-filter-btn", onClick: () => setFilterDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("line", { x1: "4", y1: "6", x2: "20", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "8", y1: "12", x2: "20", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "18", x2: "20", y2: "18" })), "Filters", totalActiveFilterCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-badge" }, totalActiveFilterCount))), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : skus.length === 0 ? searchQuery ? /* @__PURE__ */ React.createElement(SearchEmptyState, { searchQuery, categories, onSearch, onCategorySelect, didYouMean }) : /* @__PURE__ */ React.createElement("div", { className: "browse-empty" }, /* @__PURE__ */ React.createElement("p", null, "No products found"), /* @__PURE__ */ React.createElement("p", null, "Try adjusting your filters")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SkuGrid, { skus, onSkuClick, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku, viewMode }), totalPages > 1 && /* @__PURE__ */ React.createElement(Pagination, { currentPage, totalPages, onPageChange })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-overlay" + (filterDrawerOpen ? " open" : ""), onClick: () => setFilterDrawerOpen(false) }), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer" + (filterDrawerOpen ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Filters", totalActiveFilterCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, totalActiveFilterCount)), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: () => setFilterDrawerOpen(false) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), hasFilters && /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-pills" }, /* @__PURE__ */ React.createElement(
      ActiveFilterPills,
      {
        filters,
        facets,
        onFilterToggle,
        onClearFilters,
        vendorFilters,
        onVendorToggle,
        userPriceRange,
        onPriceRangeChange,
        tagFilters,
        tagFacets,
        onTagToggle,
        inline: true
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-body" }, /* @__PURE__ */ React.createElement(FacetPanel, { ...facetProps, isMobile: true })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-footer" }, /* @__PURE__ */ React.createElement("button", { className: "filter-drawer-results-btn", onClick: () => setFilterDrawerOpen(false) }, "Show ", totalSkus, " Result", totalSkus !== 1 ? "s" : ""))))));
  }
  function PriceRangeFilter({ priceRange, userPriceRange, onChange }) {
    const min = priceRange.min || 0;
    const max = priceRange.max || 1e3;
    const step = max > 100 ? 1 : 0.5;
    const curMin = userPriceRange.min != null ? userPriceRange.min : min;
    const curMax = userPriceRange.max != null ? userPriceRange.max : max;
    const [localMin, setLocalMin] = useState(curMin);
    const [localMax, setLocalMax] = useState(curMax);
    useEffect(() => {
      setLocalMin(userPriceRange.min != null ? userPriceRange.min : min);
      setLocalMax(userPriceRange.max != null ? userPriceRange.max : max);
    }, [userPriceRange.min, userPriceRange.max, min, max]);
    const pctMin = (localMin - min) / (max - min) * 100;
    const pctMax = (localMax - min) / (max - min) * 100;
    const commit = (lo, hi) => {
      const newMin = lo > min ? lo : null;
      const newMax = hi < max ? hi : null;
      if (newMin === null && newMax === null) onChange(null, null);
      else onChange(newMin, newMax);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "price-range-wrapper" }, /* @__PURE__ */ React.createElement("div", { className: "price-range-slider" }, /* @__PURE__ */ React.createElement("div", { className: "price-range-track" }), /* @__PURE__ */ React.createElement("div", { className: "price-range-fill", style: { left: pctMin + "%", width: pctMax - pctMin + "%" } }), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min,
        max,
        step,
        value: localMin,
        onChange: (e) => {
          const v = Math.min(parseFloat(e.target.value), localMax - step);
          setLocalMin(v);
        },
        onMouseUp: () => commit(localMin, localMax),
        onTouchEnd: () => commit(localMin, localMax)
      }
    ), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min,
        max,
        step,
        value: localMax,
        onChange: (e) => {
          const v = Math.max(parseFloat(e.target.value), localMin + step);
          setLocalMax(v);
        },
        onMouseUp: () => commit(localMin, localMax),
        onTouchEnd: () => commit(localMin, localMax)
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "price-range-inputs" }, /* @__PURE__ */ React.createElement("div", { className: "price-input-wrap" }, /* @__PURE__ */ React.createElement("span", null, "$"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "number",
        min,
        max,
        step,
        value: localMin,
        onChange: (e) => {
          const v = parseFloat(e.target.value);
          setLocalMin(isNaN(v) ? min : v);
        },
        onBlur: () => commit(localMin, localMax)
      }
    )), /* @__PURE__ */ React.createElement("span", { className: "price-range-dash" }, "\u2013"), /* @__PURE__ */ React.createElement("div", { className: "price-input-wrap" }, /* @__PURE__ */ React.createElement("span", null, "$"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "number",
        min,
        max,
        step,
        value: localMax,
        onChange: (e) => {
          const v = parseFloat(e.target.value);
          setLocalMax(isNaN(v) ? max : v);
        },
        onBlur: () => commit(localMin, localMax)
      }
    ))));
  }
  function FacetPanel({
    facets,
    filters,
    onFilterToggle,
    onBatchFilterSet,
    onClearFilters,
    vendors,
    vendorFilters,
    onVendorToggle,
    priceRange,
    userPriceRange,
    onPriceRangeChange,
    tagFacets,
    tagFilters,
    onTagToggle,
    totalSkus,
    isMobile
  }) {
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
    const prioritySlugs = ["material", "finish", "size", "application"];
    const bottomSlugs = ["pei_rating", "water_absorption", "dcof"];
    const primarySlugs = ["material", "finish", "size", "application"];
    const chevron = (isOpen) => /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", className: "filter-chevron" + (isOpen ? " open" : "") }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }));
    const isGroupCollapsed = (slug) => {
      if (collapsed[slug] !== void 0) return collapsed[slug];
      if (filters[slug] && filters[slug].length > 0) return false;
      if (prioritySlugs.includes(slug)) return false;
      if (slug === "color") return false;
      return true;
    };
    const colorFacet = facets.find((f) => f.slug === "color");
    const familyCounts = {};
    if (colorFacet) {
      colorFacet.values.forEach((v) => {
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
      const familyRawValues = colorFacet.values.map((v) => v.value).filter((v) => {
        const lower = v.toLowerCase().trim();
        return keywords.some((kw) => lower.includes(kw));
      });
      if (familyRawValues.length === 0) return;
      const currentColors = filters.color || [];
      const isActive = familyRawValues.some((v) => currentColors.includes(v));
      let newColors;
      if (isActive) {
        newColors = currentColors.filter((v) => !familyRawValues.includes(v));
      } else {
        newColors = [...currentColors, ...familyRawValues.filter((v) => !currentColors.includes(v))];
      }
      onBatchFilterSet("color", newColors);
    };
    const nonColorFacets = facets.filter((f) => f.slug !== "color");
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
    const primaryFacets = sortedFacets.filter((g) => primarySlugs.includes(g.slug));
    const secondaryFacets = sortedFacets.filter((g) => !primarySlugs.includes(g.slug));
    const hasActiveSecondary = secondaryFacets.some((g) => (filters[g.slug] || []).length > 0);
    const showMoreFilters = moreFiltersOpen || hasActiveSecondary;
    const roomTags = (tagFacets || []).filter((t) => t.category === "Room");
    const featureTags = (tagFacets || []).filter((t) => t.category !== "Room");
    const roomTagActiveCount = roomTags.filter((t) => (tagFilters || []).includes(t.slug)).length;
    const featureTagActiveCount = featureTags.filter((t) => (tagFilters || []).includes(t.slug)).length;
    const FacetCheck = ({ checked, onChange, id }) => /* @__PURE__ */ React.createElement(
      "span",
      {
        className: "facet-check" + (checked ? " checked" : ""),
        onClick: onChange,
        role: "checkbox",
        "aria-checked": checked,
        tabIndex: 0,
        id,
        onKeyDown: (e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange();
          }
        }
      },
      checked && /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 12 10", fill: "none" }, /* @__PURE__ */ React.createElement("polyline", { points: "1.5 5 4.5 8 10.5 2", stroke: "#fff", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }))
    );
    const renderFilterGroup = (group) => {
      const isCol = isGroupCollapsed(group.slug);
      const searchTerm = filterSearch[group.slug] || "";
      const allValues = searchTerm ? group.values.filter((v) => v.value.toLowerCase().includes(searchTerm.toLowerCase())) : group.values;
      const activeCount = (filters[group.slug] || []).length;
      const checkId = (val) => "f-" + group.slug + "-" + val.replace(/[^a-zA-Z0-9]/g, "_");
      const isExpanded = expandedGroups[group.slug] || false;
      const shouldTruncate = !searchTerm && allValues.length > VALUE_LIMIT;
      const values = shouldTruncate && !isExpanded ? allValues.slice(0, VALUE_LIMIT) : allValues;
      const hiddenCount = allValues.length - VALUE_LIMIT;
      return /* @__PURE__ */ React.createElement("div", { key: group.slug, className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, [group.slug]: !isCol })) }, /* @__PURE__ */ React.createElement("span", null, group.name, activeCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, activeCount)), chevron(!isCol)), /* @__PURE__ */ React.createElement("div", { className: "filter-group-content" + (isCol ? " collapsed" : "") }, group.values.length > 15 && /* @__PURE__ */ React.createElement(
        "input",
        {
          className: "filter-search-input",
          type: "text",
          placeholder: "Search " + group.name.toLowerCase() + "...",
          value: searchTerm,
          onChange: (e) => setFilterSearch((prev) => ({ ...prev, [group.slug]: e.target.value })),
          onClick: (e) => e.stopPropagation()
        }
      ), /* @__PURE__ */ React.createElement("div", { className: "filter-values-scroll" }, values.map((v) => {
        const checked = (filters[group.slug] || []).includes(v.value);
        return /* @__PURE__ */ React.createElement("div", { key: v.value, className: "filter-option", onClick: () => onFilterToggle(group.slug, v.value) }, /* @__PURE__ */ React.createElement(FacetCheck, { checked, onChange: () => onFilterToggle(group.slug, v.value), id: checkId(v.value) }), /* @__PURE__ */ React.createElement("label", { htmlFor: checkId(v.value) }, formatCarpetValue(v.value)), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
      }), values.length === 0 && searchTerm && /* @__PURE__ */ React.createElement("div", { className: "filter-no-matches" }, "No matches")), shouldTruncate && /* @__PURE__ */ React.createElement("button", { className: "show-more-btn", onClick: () => setExpandedGroups((prev) => ({ ...prev, [group.slug]: !isExpanded })) }, isExpanded ? "Show less" : "Show " + hiddenCount + " more")));
    };
    return /* @__PURE__ */ React.createElement("div", { className: "filter-panel" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar-refine-header" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar-refine-top" }, /* @__PURE__ */ React.createElement("span", { className: "sidebar-refine-label" }, "Refine"), hasAny && /* @__PURE__ */ React.createElement("span", { className: "sidebar-refine-active" }, totalActiveFilterCount, " active")), /* @__PURE__ */ React.createElement("div", { className: "sidebar-refine-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "sidebar-refine-category" }, totalSkus ? totalSkus + " products" : "All materials"), hasAny && /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear all"))), vendors && vendors.length > 0 && (() => {
      const isCol = collapsed._vendor || false;
      const searchTerm = filterSearch._vendor || "";
      const allVendors = searchTerm ? vendors.filter((v) => v.name.toLowerCase().includes(searchTerm.toLowerCase())) : vendors;
      const isExpanded = expandedGroups._vendor || false;
      const shouldTruncate = !searchTerm && allVendors.length > VALUE_LIMIT;
      const visibleVendors = shouldTruncate && !isExpanded ? allVendors.slice(0, VALUE_LIMIT) : allVendors;
      const hiddenCount = allVendors.length - VALUE_LIMIT;
      return /* @__PURE__ */ React.createElement("div", { className: "filter-group vendor-filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, _vendor: !isCol })) }, /* @__PURE__ */ React.createElement("span", null, "Brand", hasVendorFilters && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, vendorFilters.length)), chevron(!isCol)), /* @__PURE__ */ React.createElement("div", { className: "filter-group-content" + (isCol ? " collapsed" : "") }, vendors.length > 15 && /* @__PURE__ */ React.createElement(
        "input",
        {
          className: "filter-search-input",
          type: "text",
          placeholder: "Search brands...",
          value: searchTerm,
          onChange: (e) => setFilterSearch((prev) => ({ ...prev, _vendor: e.target.value })),
          onClick: (e) => e.stopPropagation()
        }
      ), /* @__PURE__ */ React.createElement("div", { className: "filter-values-scroll" }, visibleVendors.map((v) => {
        const checked = vendorFilters.includes(v.name);
        return /* @__PURE__ */ React.createElement("div", { key: v.name, className: "filter-option", onClick: () => onVendorToggle(v.name) }, /* @__PURE__ */ React.createElement(FacetCheck, { checked, onChange: () => onVendorToggle(v.name), id: "f-vendor-" + v.name.replace(/[^a-zA-Z0-9]/g, "_") }), /* @__PURE__ */ React.createElement("label", { htmlFor: "f-vendor-" + v.name.replace(/[^a-zA-Z0-9]/g, "_") }, v.name), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
      })), shouldTruncate && /* @__PURE__ */ React.createElement("button", { className: "show-more-btn", onClick: () => setExpandedGroups((prev) => ({ ...prev, _vendor: !isExpanded })) }, isExpanded ? "Show less" : "Show " + hiddenCount + " more")));
    })(), roomTags.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title" }, /* @__PURE__ */ React.createElement("span", null, "Room", roomTagActiveCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, roomTagActiveCount))), /* @__PURE__ */ React.createElement("div", { className: "room-tag-grid" }, roomTags.map((tag) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: tag.slug,
        className: "room-tag-card" + ((tagFilters || []).includes(tag.slug) ? " active" : ""),
        onClick: () => onTagToggle(tag.slug)
      },
      /* @__PURE__ */ React.createElement("span", { className: "room-tag-card-name" }, tag.name),
      /* @__PURE__ */ React.createElement("span", { className: "room-tag-card-count" }, tag.count)
    )))), primaryFacets.filter((g) => g.slug === "material").map((group) => renderFilterGroup(group)), colorFacet && (() => {
      const isCol = isGroupCollapsed("color");
      return /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, color: !isCol })) }, /* @__PURE__ */ React.createElement("span", null, "Color", (filters.color || []).length > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, (filters.color || []).length)), chevron(!isCol)), /* @__PURE__ */ React.createElement("div", { className: "filter-group-content" + (isCol ? " collapsed" : "") }, /* @__PURE__ */ React.createElement("div", { className: "color-family-grid" }, Object.entries(COLOR_FAMILIES).map(([name, { hex }]) => {
        if (!familyCounts[name]) return null;
        const isActive = activeFamilies.includes(name);
        const style = hex.includes("gradient") ? { background: hex } : { backgroundColor: hex };
        return /* @__PURE__ */ React.createElement("button", { key: name, className: "color-family-swatch" + (isActive ? " active" : ""), onClick: () => handleFamilyClick(name), title: name + " (" + familyCounts[name] + ")" }, /* @__PURE__ */ React.createElement("div", { className: "color-family-circle", style }), /* @__PURE__ */ React.createElement("span", { className: "color-family-name" }, name));
      }))));
    })(), primaryFacets.filter((g) => g.slug !== "material").map((group) => renderFilterGroup(group)), priceRange && priceRange.max > 0 && (() => {
      const isCol = collapsed._price || false;
      return /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, _price: !isCol })) }, /* @__PURE__ */ React.createElement("span", null, "Price", hasPriceFilters && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, "1")), chevron(!isCol)), /* @__PURE__ */ React.createElement("div", { className: "filter-group-content" + (isCol ? " collapsed" : "") }, /* @__PURE__ */ React.createElement(PriceRangeFilter, { priceRange, userPriceRange: userPriceRange || { min: null, max: null }, onChange: onPriceRangeChange })));
    })(), featureTags.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title" }, /* @__PURE__ */ React.createElement("span", null, "Features", featureTagActiveCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, featureTagActiveCount))), /* @__PURE__ */ React.createElement("div", { className: "tag-chips" }, featureTags.map((tag) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: tag.slug,
        className: "tag-chip" + ((tagFilters || []).includes(tag.slug) ? " active" : ""),
        onClick: () => onTagToggle(tag.slug)
      },
      tag.name,
      " ",
      /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", tag.count, ")")
    )))), secondaryFacets.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "more-filters-divider" }, /* @__PURE__ */ React.createElement("button", { className: "more-filters-toggle", onClick: () => setMoreFiltersOpen((prev) => !prev) }, /* @__PURE__ */ React.createElement("span", null, "More Filters"), chevron(showMoreFilters)), /* @__PURE__ */ React.createElement("div", { className: "more-filters-content" + (showMoreFilters ? " expanded" : " collapsed") }, secondaryFacets.map((group) => renderFilterGroup(group)))));
  }
  function ActiveFilterPills({ filters, facets, onFilterToggle, onClearFilters, vendorFilters, onVendorToggle, userPriceRange, onPriceRangeChange, tagFilters, tagFacets, onTagToggle, inline }) {
    const pills = [];
    (vendorFilters || []).forEach((name) => {
      pills.push({ type: "vendor", value: name, groupLabel: "Brand", valueLabel: name, onRemove: () => onVendorToggle(name) });
    });
    (tagFilters || []).forEach((slug) => {
      const tag = (tagFacets || []).find((t) => t.slug === slug);
      pills.push({ type: "tag", value: slug, groupLabel: "Tag", valueLabel: tag ? tag.name : slug, onRemove: () => onTagToggle(slug) });
    });
    if (userPriceRange && (userPriceRange.min != null || userPriceRange.max != null)) {
      const valueLabel = "$" + (userPriceRange.min || 0) + " \u2013 $" + (userPriceRange.max || "\u221E");
      pills.push({ type: "price", value: "price", groupLabel: "Price", valueLabel, onRemove: () => onPriceRangeChange(null, null) });
    }
    Object.keys(filters).forEach((slug) => {
      const group = facets.find((f) => f.slug === slug);
      const name = group ? group.name : slug;
      (filters[slug] || []).forEach((val) => {
        pills.push({ type: "attr", slug, value: val, groupLabel: name, valueLabel: val, onRemove: () => onFilterToggle(slug, val) });
      });
    });
    if (pills.length === 0) return null;
    if (inline) {
      return pills.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "filter-pill", style: { whiteSpace: "nowrap", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("span", { className: "filter-pill-group" }, p.groupLabel, ":"), /* @__PURE__ */ React.createElement("span", null, p.valueLabel), /* @__PURE__ */ React.createElement("button", { onClick: p.onRemove }, "\xD7")));
    }
    return /* @__PURE__ */ React.createElement("div", { className: "active-filters" }, /* @__PURE__ */ React.createElement("span", { className: "active-filters-label" }, "Refined by"), pills.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "filter-pill" }, /* @__PURE__ */ React.createElement("span", { className: "filter-pill-group" }, p.groupLabel, ":"), /* @__PURE__ */ React.createElement("span", null, p.valueLabel), /* @__PURE__ */ React.createElement("button", { onClick: p.onRemove }, "\xD7"))), /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear all"));
  }
  function BrowseToolbar({ totalSkus, sortBy, onSortChange, currentPage, viewMode, onViewModeChange, searchQuery, searchTimeMs, relatedSearches, onSearch, matchingCategories, onCategorySelect }) {
    const page = currentPage || 1;
    const per = 24;
    const startIdx = (page - 1) * per + 1;
    const endIdx = Math.min(page * per, totalSkus);
    const mode = viewMode || "grid";
    const isSearching = !!searchQuery;
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "browse-toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "result-count" }, totalSkus > 0 ? "Showing " + startIdx + "\u2013" + endIdx + " of " + totalSkus + (searchTimeMs != null ? " in " + (searchTimeMs / 1e3).toFixed(2) + "s" : "") : "0 products"), /* @__PURE__ */ React.createElement("div", { className: "browse-toolbar-right" }, onViewModeChange && /* @__PURE__ */ React.createElement("div", { className: "view-mode-toggle" }, ["grid", "compact", "spec"].map((m) => /* @__PURE__ */ React.createElement("button", { key: m, className: "view-mode-btn" + (mode === m ? " active" : ""), onClick: () => onViewModeChange(m) }, m === "grid" ? "Grid" : m === "compact" ? "Compact" : "Spec"))), /* @__PURE__ */ React.createElement("div", { className: "sort-group" }, /* @__PURE__ */ React.createElement("span", { className: "sort-label" }, "Sort"), /* @__PURE__ */ React.createElement("select", { value: sortBy, onChange: (e) => onSortChange(e.target.value) }, isSearching && /* @__PURE__ */ React.createElement("option", { value: "relevance" }, "Best Match"), /* @__PURE__ */ React.createElement("option", { value: "name_asc" }, "Name A-Z"), /* @__PURE__ */ React.createElement("option", { value: "name_desc" }, "Name Z-A"), /* @__PURE__ */ React.createElement("option", { value: "price_asc" }, `Price: Low \u2192 High`), /* @__PURE__ */ React.createElement("option", { value: "price_desc" }, `Price: High \u2192 Low`), /* @__PURE__ */ React.createElement("option", { value: "newest" }, "Newest"))))), isSearching && matchingCategories && matchingCategories.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "browse-category-pills" }, matchingCategories.map((cat) => /* @__PURE__ */ React.createElement("button", { key: cat.slug, className: "browse-category-pill", onClick: () => onCategorySelect(cat.slug) }, cat.name, cat.product_count > 0 && /* @__PURE__ */ React.createElement("span", { className: "browse-category-pill-count" }, cat.product_count)))), isSearching && relatedSearches && relatedSearches.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "browse-related-searches" }, /* @__PURE__ */ React.createElement("span", { className: "browse-related-label" }, "Related:"), relatedSearches.map((term) => /* @__PURE__ */ React.createElement("button", { key: term, className: "browse-related-pill", onClick: () => onSearch(term) }, term))));
  }
  function SkeletonGrid({ count = 8 }) {
    return /* @__PURE__ */ React.createElement("div", { className: "skeleton-grid" }, Array.from({ length: count }, (_, i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-card-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" }))));
  }
  function SkuGrid({ skus, onSkuClick, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku, viewMode }) {
    const gridClass = "sku-grid" + (viewMode === "compact" ? " sku-grid--compact" : viewMode === "spec" ? " sku-grid--spec" : "");
    return /* @__PURE__ */ React.createElement(React.Fragment, null, viewMode === "spec" && /* @__PURE__ */ React.createElement("div", { className: "spec-header" }, /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement("div", { className: "spec-header-cols" }, /* @__PURE__ */ React.createElement("span", { className: "spec-header-col" }, "Product"), /* @__PURE__ */ React.createElement("span", { className: "spec-header-col" }, "Brand"), /* @__PURE__ */ React.createElement("span", { className: "spec-header-col" }, "Price"))), /* @__PURE__ */ React.createElement("div", { className: gridClass }, skus.map((sku, idx) => /* @__PURE__ */ React.createElement(
      SkuCard,
      {
        key: sku.sku_id,
        sku,
        index: idx,
        onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection),
        isWished: wishlist.includes(sku.sku_id),
        onToggleWishlist: () => toggleWishlist2(sku.sku_id),
        onQuickView: setQuickViewSku ? () => setQuickViewSku(sku) : null
      }
    ))));
  }
  function Pagination({ currentPage, totalPages, onPageChange }) {
    const pages = [];
    const maxVisible = 7;
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let end = start + maxVisible - 1;
    if (end > totalPages) {
      end = totalPages;
      start = Math.max(1, end - maxVisible + 1);
    }
    if (start > 1) {
      pages.push(1);
      if (start > 2) pages.push("...");
    }
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages) {
      if (end < totalPages - 1) pages.push("...");
      pages.push(totalPages);
    }
    return /* @__PURE__ */ React.createElement("nav", { className: "pagination", "aria-label": "Product pages" }, /* @__PURE__ */ React.createElement("button", { className: "pagination-btn", disabled: currentPage <= 1, onClick: () => onPageChange(currentPage - 1) }, "\u2190", " Previous"), /* @__PURE__ */ React.createElement("div", { className: "pagination-pages" }, pages.map((p, i) => p === "..." ? /* @__PURE__ */ React.createElement("span", { key: "e" + i, className: "pagination-ellipsis" }, "\u2026") : /* @__PURE__ */ React.createElement("button", { key: p, className: "pagination-num" + (p === currentPage ? " active" : ""), onClick: () => onPageChange(p), ...p === currentPage ? { "aria-current": "page" } : {} }, p))), /* @__PURE__ */ React.createElement("button", { className: "pagination-btn", disabled: currentPage >= totalPages, onClick: () => onPageChange(currentPage + 1) }, "Next ", "\u2192"));
  }
  function SkuCard({ sku, onClick, isWished, onToggleWishlist, onQuickView, index }) {
    const isAboveFold = index != null && index < 8;
    const onSale = sku.sale_price != null && !sku.trade_price;
    const basePrice = isCarpet(sku) ? sku.cut_price : sku.retail_price;
    const price = sku.trade_price || (onSale ? sku.sale_price : basePrice);
    const discountPct = onSale && parseFloat(basePrice) > 0 ? Math.round((1 - parseFloat(sku.sale_price) / parseFloat(basePrice)) * 100) : 0;
    const catName = sku.category_name || "";
    const variantLabel = sku.variant_name || "";
    const vendorLabel = sku.brand_name || sku.vendor_name || "";
    const stockStatus = sku.stock_status || "unknown";
    const lowStockQty = sku.low_stock_qty;
    const stockLabel = stockStatus === "in_stock" ? "In stock" : stockStatus === "low_stock" ? lowStockQty ? sku.sell_by === "unit" ? "Only " + lowStockQty + " left" : sku.sell_by === "box" ? "Only " + lowStockQty + " boxes left" : "Low stock" : "Low stock" : stockStatus === "out_of_stock" ? "Out of stock" : "";
    const stockClass = stockStatus === "in_stock" ? "sku-card-stock--in" : stockStatus === "low_stock" ? "sku-card-stock--low" : "sku-card-stock--out";
    const hasVariants = sku.variant_count > 1;
    const variantImages = sku.variant_images || [];
    return /* @__PURE__ */ React.createElement("div", { className: "sku-card", onClick, "data-sku": sku.vendor_sku || sku.internal_sku }, /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 400), ...optimizeSrcSet(sku.primary_image, [200, 400, 600]), sizes: "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw", alt: sku.product_name, loading: isAboveFold ? "eager" : "lazy", fetchPriority: isAboveFold ? "high" : "auto", decoding: isAboveFold ? "sync" : "async", width: "300", height: "280" }), sku.alternate_image && /* @__PURE__ */ React.createElement("img", { className: "sku-card-alt-img", onLoad: handleProductImgLoad, src: optimizeImg(sku.alternate_image, 400), ...optimizeSrcSet(sku.alternate_image, [200, 400, 600]), sizes: "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw", alt: "", loading: "lazy", decoding: "async", width: "300", height: "280" }), onSale && /* @__PURE__ */ React.createElement("span", { className: "sale-badge" }, "SALE"), /* @__PURE__ */ React.createElement("div", { className: "sku-card-hover-actions" }, /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "sku-card-action-btn wishlist-heart" + (isWished ? " active" : ""),
        onClick: (e) => {
          e.stopPropagation();
          onToggleWishlist();
        },
        title: "Save to wishlist"
      },
      /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: isWished ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" }))
    )), onQuickView && /* @__PURE__ */ React.createElement("div", { className: "sku-card-qv-gradient", onClick: (e) => {
      e.stopPropagation();
      onQuickView();
    } }, /* @__PURE__ */ React.createElement("button", { className: "sku-card-qv-btn" }, "Quick View"))), /* @__PURE__ */ React.createElement("div", { className: "sku-card-body" }, /* @__PURE__ */ React.createElement("div", { className: "sku-card-meta-row" }, /* @__PURE__ */ React.createElement("span", null, catName), stockLabel && /* @__PURE__ */ React.createElement("span", { className: "sku-card-stock " + stockClass }, "\u25CF", " ", stockLabel)), /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, fullProductName(sku)), hasVariants && variantImages.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "sku-card-variant-swatches" }, variantImages.slice(0, 5).map((vi, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "sku-card-variant-dot" }, vi.image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(vi.image, 60), alt: "", loading: "lazy", decoding: "async", width: 22, height: 22 }) : null)), variantImages.length > 5 && /* @__PURE__ */ React.createElement("span", { className: "sku-card-variant-more" }, "+", variantImages.length - 5)), /* @__PURE__ */ React.createElement("div", { className: "sku-card-vendor" }, variantLabel && vendorLabel ? variantLabel + " \xB7 " + vendorLabel : vendorLabel || variantLabel, !variantLabel && !vendorLabel && hasVariants && sku.variant_count + " " + ((sku.attributes || []).some((a) => a.slug === "color") ? "colors" : "options")), /* @__PURE__ */ React.createElement("div", { className: "sku-card-price-row" }, /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, price ? /* @__PURE__ */ React.createElement(React.Fragment, null, sku.trade_price && basePrice && /* @__PURE__ */ React.createElement("span", { className: "sku-card-trade-strike" }, "$", displayPrice(sku, basePrice).toFixed(2)), onSale && /* @__PURE__ */ React.createElement("span", { className: "sale-original-price" }, "$", displayPrice(sku, basePrice).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: onSale ? "sale-price-text" : "" }, "$", displayPrice(sku, price).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "price-suffix" }, priceSuffix(sku))) : "Call for Price"), /* @__PURE__ */ React.createElement("span", { className: "sku-card-view-link" }, "View \u2192"))));
  }
  function SkuDetailView({ skuId, goBack, addToCart, cart, onSkuClick, onRequestInstall, tradeCustomer, wishlist, toggleWishlist: toggleWishlist2, recentlyViewed, addRecentlyViewed, customer, customerToken, onShowAuth, showToast, categories }) {
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
    const [expandedAdexCats, setExpandedAdexCats] = useState(/* @__PURE__ */ new Set());
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState(null);
    const [addingToCart, setAddingToCart] = useState(false);
    const [sqftInput, setSqftInput] = useState("");
    const [boxesInput, setBoxesInput] = useState("");
    const [includeOverage, setIncludeOverage] = useState(false);
    const [unitQty, setUnitQty] = useState(1);
    const [accessoryQtys, setAccessoryQtys] = useState({});
    const [carpetInputMode, setCarpetInputMode] = useState("linear");
    const [roomWidth, setRoomWidth] = useState("");
    const [roomLength, setRoomLength] = useState("");
    const [linearFeet, setLinearFeet] = useState("");
    const [includeCarpetOverage, setIncludeCarpetOverage] = useState(false);
    const [reviews, setReviews] = useState([]);
    const [avgRating, setAvgRating] = useState(0);
    const [reviewCount, setReviewCount] = useState(0);
    const [reviewRating, setReviewRating] = useState(0);
    const [reviewHover, setReviewHover] = useState(0);
    const [reviewTitle, setReviewTitle] = useState("");
    const [reviewBody, setReviewBody] = useState("");
    const [reviewSubmitting, setReviewSubmitting] = useState(false);
    const [reviewSubmitted, setReviewSubmitted] = useState(false);
    const [notFoundSearch, setNotFoundSearch] = useState("");
    const [alertEmail, setAlertEmail] = useState("");
    const [alertSubscribed, setAlertSubscribed] = useState(false);
    const [alertLoading, setAlertLoading] = useState(false);
    const [alertSuccess, setAlertSuccess] = useState(false);
    const sectionRefs = {
      details: useRef(null),
      companions: useRef(null),
      variants: useRef(null),
      collection: useRef(null),
      recent: useRef(null),
      reviews: useRef(null)
    };
    const navRef = useRef(null);
    useEffect(() => {
      const handleScroll = () => {
        const nav = navRef.current;
        if (!nav) return;
        const show = window.scrollY > 300;
        nav.classList.toggle("visible", show);
        const offset = 140;
        const entries = Object.entries(sectionRefs);
        let current = "details";
        for (const [key, ref] of entries) {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            if (rect.top <= offset) current = key;
          }
        }
        nav.querySelectorAll(".pdp-section-nav-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.section === current);
        });
      };
      window.addEventListener("scroll", handleScroll, { passive: true });
      return () => window.removeEventListener("scroll", handleScroll);
    }, []);
    const scrollToSection = (key) => {
      const ref = sectionRefs[key];
      if (ref && ref.current) {
        const navH = navRef.current ? navRef.current.offsetHeight : 0;
        const y = ref.current.getBoundingClientRect().top + window.scrollY - 90 - navH - 12;
        window.scrollTo({ top: y, behavior: "smooth" });
      }
    };
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
          col.el.style.top = col.top + "px";
        }
        return cols;
      };
      const handleDualSticky = () => {
        if (window.innerWidth < 769) return;
        const scrollY = window.scrollY;
        const delta = scrollY - lastScrollY;
        const vh = window.innerHeight;
        const nav = document.querySelector(".pdp-section-nav");
        const navH = nav && nav.classList.contains("visible") ? nav.offsetHeight : 0;
        const HEADER = HEADER_BASE + navH;
        const gallery = galleryRef.current;
        const info = infoRef.current;
        if (gallery && info) {
          const r = updateStickyPair(
            { el: gallery, top: galleryTop },
            { el: info, top: infoTop },
            delta,
            vh,
            HEADER
          );
          galleryTop = r[0].top;
          infoTop = r[1].top;
        }
        const revSidebar = reviewsSidebarRef.current;
        const revMain = reviewsMainRef.current;
        if (revSidebar && revMain) {
          const r = updateStickyPair(
            { el: revSidebar, top: revSidebarTop },
            { el: revMain, top: revMainTop },
            delta,
            vh,
            HEADER
          );
          revSidebarTop = r[0].top;
          revMainTop = r[1].top;
        }
        lastScrollY = scrollY;
      };
      window.addEventListener("scroll", handleDualSticky, { passive: true });
      return () => window.removeEventListener("scroll", handleDualSticky);
    }, []);
    useEffect(() => {
      setLoading(true);
      setFetchError(null);
      setSelectedImage(0);
      setMedia([]);
      setAccessoryQtys({});
      const headers = {};
      const t = localStorage.getItem("trade_token");
      if (t) headers["X-Trade-Token"] = t;
      fetch(API + "/api/storefront/skus/" + skuId, { headers }).then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "not_found" : "server_error");
        return r.json();
      }).then((data) => {
        if (data.redirect_to_sku) {
          onSkuClick(data.redirect_to_sku);
          return;
        }
        if (data.error || !data.sku) {
          setFetchError("not_found");
          setLoading(false);
          return;
        }
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
          addRecentlyViewed({ sku_id: data.sku.sku_id, product_name: data.sku.product_name, variant_name: data.sku.variant_name, primary_image: data.media && data.media[0] ? data.media[0].url : null, retail_price: data.sku.retail_price, cut_price: data.sku.cut_price, price_basis: data.sku.price_basis, sell_by: data.sku.sell_by, sqft_per_box: data.sku.sqft_per_box });
        }
        if (data.sku) {
          const skuTitle = fullProductName(data.sku) + " | Roma Flooring Designs";
          const skuDesc = cleanDescription(data.sku.description_short, data.sku.brand_name || data.sku.vendor_name) || "Premium " + data.sku.product_name + " from Roma Flooring Designs";
          const skuImage = data.media && data.media[0] ? data.media[0].url : null;
          updateSEO({ title: skuTitle, description: skuDesc, url: SITE_URL + "/shop/sku/" + skuId, image: skuImage });
          fetch(API + "/api/storefront/products/" + data.sku.product_id + "/reviews").then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).then((revData) => {
            setReviews(revData.reviews || []);
            setAvgRating(revData.average_rating || 0);
            setReviewCount(revData.review_count || 0);
            if (customer) {
              const existing = (revData.reviews || []).find((r) => r.first_name === customer.first_name);
              if (existing) {
                setReviewRating(existing.rating);
                setReviewTitle(existing.title || "");
                setReviewBody(existing.body || "");
                setReviewSubmitted(true);
              }
            }
          }).catch(() => {
          });
          if (data.sku.stock_status === "out_of_stock" && data.sku.vendor_has_inventory !== false) {
            const alertEmail2 = customer ? customer.email : "";
            if (alertEmail2) {
              fetch(API + "/api/storefront/stock-alerts/check?sku_id=" + data.sku.sku_id + "&email=" + encodeURIComponent(alertEmail2)).then((r) => {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
              }).then((d) => {
                if (d.subscribed) setAlertSubscribed(true);
              }).catch(() => {
              });
            }
          }
        }
      }).catch((err) => {
        console.error(err);
        setFetchError(err.message === "not_found" ? "not_found" : "error");
        setLoading(false);
      });
    }, [skuId]);
    useEffect(() => {
      if (!sku) return;
      const skuDesc = cleanDescription(sku.description_short, sku.brand_name || sku.vendor_name) || "Premium " + sku.product_name + " from Roma Flooring Designs";
      const skuImage = media && media[0] ? media[0].url : null;
      const product = {
        "@type": "Product",
        name: sku.product_name,
        description: skuDesc,
        image: skuImage,
        sku: sku.sku_code || String(sku.sku_id),
        mpn: sku.sku_code || "",
        brand: { "@type": "Brand", name: sku.brand_name || sku.vendor_name || "Roma Flooring Designs" },
        category: sku.category_name || "",
        offers: {
          "@type": "Offer",
          url: SITE_URL + "/shop/sku/" + skuId,
          priceCurrency: "USD",
          price: displayPrice(sku, sku.sale_price || skuListPrice(sku)).toFixed(2),
          availability: sku.stock_status === "in_stock" ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
          seller: { "@type": "Organization", name: "Roma Flooring Designs" }
        }
      };
      if (reviewCount > 0) {
        product.aggregateRating = { "@type": "AggregateRating", ratingValue: avgRating.toFixed(1), reviewCount, bestRating: 5, worstRating: 1 };
      }
      setDynamicJsonLd({ "@context": "https://schema.org", "@graph": [
        product,
        { "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL + "/" },
          { "@type": "ListItem", position: 2, name: "Shop", item: SITE_URL + "/shop" },
          sku.category_name ? { "@type": "ListItem", position: 3, name: sku.category_name, item: SITE_URL + "/shop?category=" + (sku.category_slug || "") } : null,
          { "@type": "ListItem", position: sku.category_name ? 4 : 3, name: sku.product_name, item: SITE_URL + "/shop/sku/" + skuId }
        ].filter(Boolean) }
      ] });
    }, [sku, media, avgRating, reviewCount]);
    const sqftPerBox = sku ? parseFloat(sku.sqft_per_box) || 0 : 0;
    const retailPrice = sku ? displayPrice(sku, skuListPrice(sku)) : 0;
    const salePrice = sku && sku.sale_price ? displayPrice(sku, sku.sale_price) : null;
    const tradePrice = sku && sku.trade_price ? displayPrice(sku, sku.trade_price) : null;
    const msrpAttr = sku && (sku.attributes || []).find((a) => a.slug === "msrp");
    const msrpPrice = msrpAttr && parseFloat(msrpAttr.value) > 0 ? parseFloat(msrpAttr.value) : null;
    const isCarpetSku = sku && isCarpet(sku);
    const cutPrice = isCarpetSku ? parseFloat(sku.cut_price) : 0;
    const rollPrice = isCarpetSku ? parseFloat(sku.roll_price) : 0;
    const rollMinSqft = isCarpetSku && sku.roll_min_sqft ? parseFloat(sku.roll_min_sqft) : 0;
    const rollWidthFt = isCarpetSku && sku.roll_width_ft ? parseFloat(sku.roll_width_ft) : 0;
    const rollLengthFt = isCarpetSku && sku.roll_length_ft ? parseFloat(sku.roll_length_ft) : 0;
    const effectiveCarpetMode = carpetInputMode === "linear" && rollWidthFt <= 0 ? "dimensions" : carpetInputMode;
    const carpetRawSqft = isCarpetSku ? effectiveCarpetMode === "linear" ? rollWidthFt * (parseFloat(linearFeet) || 0) : effectiveCarpetMode === "dimensions" ? (parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0) : parseFloat(sqftInput) || 0 : 0;
    const carpetSqft = includeCarpetOverage ? Math.ceil(carpetRawSqft * 11 / 10) : carpetRawSqft;
    const carpetPriceTier = isCarpetSku && rollMinSqft > 0 && carpetSqft >= rollMinSqft ? "roll" : "cut";
    const carpetActivePrice = isCarpetSku ? carpetPriceTier === "roll" ? rollPrice : cutPrice : 0;
    const carpetSqyd = carpetSqft / 9;
    const carpetSubtotal = carpetSqyd * carpetActivePrice;
    const carpetSqftToRoll = isCarpetSku && rollMinSqft > 0 && carpetSqft > 0 && carpetSqft < rollMinSqft ? rollMinSqft - carpetSqft : 0;
    const carpetRollSavings = isCarpetSku && carpetSqftToRoll > 0 ? ((cutPrice - rollPrice) * (rollMinSqft / 9)).toFixed(2) : "0";
    const carpetWeightPerSqyd = isCarpetSku ? (() => {
      const wAttr = (sku.attributes || []).find((a) => a.slug === "weight_per_sqyd");
      if (wAttr) return parseFloat(wAttr.value) || 0;
      if (sku.weight_per_pallet_lbs && sku.sqft_per_pallet) {
        return parseFloat(sku.weight_per_pallet_lbs) / (parseFloat(sku.sqft_per_pallet) / 9) || 0;
      }
      return 0;
    })() : 0;
    const carpetEstWeight = carpetWeightPerSqyd > 0 ? carpetSqyd * carpetWeightPerSqyd : 0;
    const carpetNeedsSeam = isCarpetSku && effectiveCarpetMode === "dimensions" && rollWidthFt > 0 && (parseFloat(roomWidth) || 0) > rollWidthFt;
    const effectivePrice = isCarpetSku ? carpetActivePrice : tradePrice || salePrice || retailPrice;
    const handleSqftChange = (val) => {
      setSqftInput(val);
      if (sqftPerBox > 0 && val) {
        let sqft = parseFloat(val) || 0;
        if (includeOverage) sqft *= 1.1;
        const boxes = Math.ceil(sqft / sqftPerBox);
        setBoxesInput(boxes > 0 ? boxes.toString() : "");
      } else {
        setBoxesInput("");
      }
    };
    const handleBoxesChange = (val) => {
      setBoxesInput(val);
      if (sqftPerBox > 0 && val) {
        const boxes = parseInt(val) || 0;
        setSqftInput(boxes > 0 ? (boxes * sqftPerBox).toFixed(1) : "");
      } else {
        setSqftInput("");
      }
    };
    useEffect(() => {
      if (sqftInput && sqftPerBox > 0) {
        let sqft = parseFloat(sqftInput) || 0;
        if (includeOverage) sqft *= 1.1;
        const boxes = Math.ceil(sqft / sqftPerBox);
        setBoxesInput(boxes > 0 ? boxes.toString() : "");
      }
    }, [includeOverage]);
    const numBoxes = parseInt(boxesInput) || 0;
    const actualSqft = numBoxes * sqftPerBox;
    const subtotal = actualSqft * effectivePrice;
    const isPerUnit = sku && isSoldPerUnit(sku);
    const isSoldPerSqft = sku && sku.sell_by === "sqft";
    const hasBoxCalc = !isPerUnit && !isSoldPerSqft && sqftPerBox > 0;
    const isSqftNoBox = !isPerUnit && !isSoldPerSqft && sqftPerBox <= 0;
    const sheetRollWidthFt = isSqftNoBox && !isCarpetSku && sku ? parseRollWidthFt(sku.product_name || "") : 0;
    const isSheetVinyl = isSqftNoBox && !isCarpetSku && sheetRollWidthFt > 0;
    const sheetMode = isSheetVinyl ? carpetInputMode === "linear" && sheetRollWidthFt <= 0 ? "dimensions" : carpetInputMode : null;
    const sheetRawSqft = isSheetVinyl ? sheetMode === "linear" ? sheetRollWidthFt * (parseFloat(linearFeet) || 0) : sheetMode === "dimensions" ? (parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0) : parseFloat(sqftInput) || 0 : 0;
    const sheetSqft = isSheetVinyl && includeCarpetOverage ? Math.ceil(sheetRawSqft * 11 / 10) : sheetRawSqft;
    const sheetSubtotal = sheetSqft * effectivePrice;
    const sheetNeedsSeam = isSheetVinyl && sheetMode === "dimensions" && sheetRollWidthFt > 0 && (parseFloat(roomWidth) || 0) > sheetRollWidthFt;
    const slabMissingSize = isPerUnit && sku && (sku.price_basis === "sqft" || sku.price_basis === "per_sqft") && !(parseFloat(sku.sqft_per_box) > 0);
    const isSlabUnit = sku && sku.sell_by === "unit" && sqftPerBox >= 4 && !(parseInt(sku.pieces_per_box) > 1);
    const isSheetUnit = !isSlabUnit && hasBoxCalc && sqftPerBox < 4 && !sku.pieces_per_box;
    const boxLabel = isSlabUnit ? "slab" : isSheetUnit ? "sheet" : "box";
    const boxLabelPlural = isSlabUnit ? "slabs" : isSheetUnit ? "sheets" : "boxes";
    const unitSubtotal = unitQty * effectivePrice;
    const sqftOnlySubtotal = (parseFloat(sqftInput) || 0) * effectivePrice;
    const sqftCalcRaw = parseFloat(sqftInput) || 0;
    const sqftCalcAmount = isSoldPerSqft && includeOverage ? Math.ceil(sqftCalcRaw * 11 / 10) : sqftCalcRaw;
    const sqftCalcSubtotal = sqftCalcAmount * effectivePrice;
    const handleReviewSubmit = async () => {
      if (!customer || !customerToken || reviewRating < 1) return;
      setReviewSubmitting(true);
      try {
        const resp = await fetch(API + "/api/storefront/products/" + sku.product_id + "/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Customer-Token": customerToken },
          body: JSON.stringify({ rating: reviewRating, title: reviewTitle, body: reviewBody })
        });
        if (resp.ok) {
          setReviewSubmitted(true);
          const revData = await (await fetch(API + "/api/storefront/products/" + sku.product_id + "/reviews")).json();
          setReviews(revData.reviews || []);
          setAvgRating(revData.average_rating || 0);
          setReviewCount(revData.review_count || 0);
        }
      } catch (err) {
        console.error("Review submit error:", err);
      }
      setReviewSubmitting(false);
    };
    const handleStockAlertSubmit = async () => {
      const email = customer ? customer.email : alertEmail;
      if (!email || !sku) return;
      setAlertLoading(true);
      try {
        const headers = { "Content-Type": "application/json" };
        if (customerToken) headers["X-Customer-Token"] = customerToken;
        const resp = await fetch(API + "/api/storefront/stock-alerts", {
          method: "POST",
          headers,
          body: JSON.stringify({ sku_id: sku.sku_id, email })
        });
        if (resp.ok) {
          setAlertSuccess(true);
          setAlertSubscribed(true);
        }
      } catch (err) {
        console.error("Stock alert error:", err);
      }
      setAlertLoading(false);
    };
    const isOutOfStock = sku && sku.stock_status === "out_of_stock" && sku.vendor_has_inventory !== false;
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
          sell_by: "roll",
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
          sell_by: "unit"
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
          sell_by: "sqft"
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
          sell_by: "box"
        });
      } else if (isSheetVinyl) {
        if (sheetSqft <= 0) return;
        addToCart({
          product_id: sku.product_id,
          sku_id: sku.sku_id,
          sqft_needed: sheetSqft,
          num_boxes: 1,
          unit_price: effectivePrice,
          subtotal: sheetSubtotal.toFixed(2),
          sell_by: "box"
        });
      } else {
        const sqft = parseFloat(sqftInput) || 0;
        if (sqft <= 0) return;
        addToCart({
          product_id: sku.product_id,
          sku_id: sku.sku_id,
          sqft_needed: sqft,
          num_boxes: 1,
          unit_price: effectivePrice,
          subtotal: (sqft * effectivePrice).toFixed(2),
          sell_by: "box"
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
        subtotal: "0.00",
        is_sample: true
      });
    };
    if (fetchError) return /* @__PURE__ */ React.createElement("div", { className: "not-found-page" }, /* @__PURE__ */ React.createElement("div", { className: "not-found-hero" }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "5rem", fontWeight: 200, color: "var(--stone-300)", lineHeight: 1, fontFamily: "var(--font-heading)" } }, fetchError === "not_found" ? "404" : "Oops"), /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontSize: "2rem", fontWeight: 300, margin: "0.75rem 0" } }, fetchError === "not_found" ? "Product Not Found" : "Something Went Wrong"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem", lineHeight: 1.6, maxWidth: 420, margin: "0 auto 1.5rem" } }, fetchError === "not_found" ? "This product may have been removed or the link may be incorrect. Try searching for what you need." : "We had trouble loading this product. Please try again."), fetchError === "not_found" && /* @__PURE__ */ React.createElement("form", { className: "not-found-search", onSubmit: (e) => {
      e.preventDefault();
      if (notFoundSearch.trim()) {
        goBack();
        setTimeout(() => window.dispatchEvent(new CustomEvent("storefront-search", { detail: notFoundSearch.trim() })), 50);
      }
    } }, /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Search for products...", value: notFoundSearch, onChange: (e) => setNotFoundSearch(e.target.value) }), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn" }, "Search")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: goBack, style: { marginTop: "1rem" } }, "Back to Shop")), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, rv.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(rv.primary_image, 400), alt: rv.product_name, loading: "lazy" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(rv)), skuListPrice(rv) && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(rv, skuListPrice(rv)).toFixed(2), priceSuffix(rv)))))), fetchError === "not_found" && categories && categories.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2.5rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Popular Categories"), /* @__PURE__ */ React.createElement("div", { className: "not-found-cats" }, categories.slice(0, 8).map((cat) => /* @__PURE__ */ React.createElement("a", { key: cat.slug, className: "not-found-cat-link", href: "#", onClick: (e) => {
      e.preventDefault();
      goBack();
    } }, cat.name)))));
    if (loading && !sku) return /* @__PURE__ */ React.createElement("div", { className: "sku-detail", style: { minHeight: "80vh" } }, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 12, background: "var(--stone-100)", borderRadius: 2 } }), /* @__PURE__ */ React.createElement("div", { style: { width: 80, height: 12, background: "var(--stone-100)", borderRadius: 2 } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery" }, /* @__PURE__ */ React.createElement("div", { style: { width: "100%", paddingBottom: "100%", background: "var(--stone-100)", animation: "pulse 1.5s ease-in-out infinite" } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info" }, /* @__PURE__ */ React.createElement("div", { style: { width: "40%", height: 16, background: "var(--stone-100)", borderRadius: 2, marginBottom: "1rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "70%", height: 32, background: "var(--stone-100)", borderRadius: 2, marginBottom: "0.75rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "50%", height: 14, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "30%", height: 28, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: 200, background: "var(--stone-50)", borderRadius: 2 } }))));
    if (!sku) return /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "6rem", color: "var(--stone-600)" } }, "SKU not found");
    const images = media.filter((m) => m.asset_type === "primary" || m.asset_type === "alternate" || m.asset_type === "swatch" || m.asset_type === "lifestyle");
    const specPdfs = media.filter((m) => m.asset_type === "spec_pdf");
    const mainImage = images[selectedImage] || images[0];
    const mainSiblings = siblings;
    const accessorySiblings = groupedProducts.length > 0 ? [] : skuAccessories;
    const isAdexProduct = /adex/i.test(sku.vendor_name || "");
    const navSections = [{ key: "details", label: "Details" }];
    if (groupedProducts.length > 0) navSections.push({ key: "companions", label: "Complete the Look" });
    if (!isAdexProduct && mainSiblings.length > 0) navSections.push({ key: "variants", label: "Variants" });
    if (!isAdexProduct && collectionSiblings.length > 0) navSections.push({ key: "collection", label: "Collection" });
    if (recentlyViewed && recentlyViewed.filter((r) => r.sku_id !== skuId).length > 0) navSections.push({ key: "recent", label: "Recently Viewed" });
    navSections.push({ key: "reviews", label: "Reviews" });
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "pdp-section-nav", ref: navRef }, navSections.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.key, "data-section": s.key, className: "pdp-section-nav-btn" + (s.key === "details" ? " active" : ""), onClick: () => scrollToSection(s.key) }, s.label))), /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "sku-detail" + (images.every((img) => /swatch|alternate/i.test(img.asset_type || "")) ? " sku-detail--contain" : ""), "data-sku": sku.vendor_sku || sku.internal_sku, style: loading ? { opacity: 0.6, pointerEvents: "none", transition: "opacity 0.15s ease" } : { animation: "pdpFadeIn 280ms ease-out both" } }, /* @__PURE__ */ React.createElement("button", { className: "pdp-back-btn", onClick: goBack, "aria-label": "Back" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", style: { width: 18, height: 18 } }, /* @__PURE__ */ React.createElement("path", { d: "M19 12H5" }), /* @__PURE__ */ React.createElement("path", { d: "M12 19l-7-7 7-7" }))), /* @__PURE__ */ React.createElement("div", { className: "pdp-breadcrumbs" }, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goBack();
    } }, "Shop"), /* @__PURE__ */ React.createElement("span", { className: "pdp-crumb" }), sku.category_name && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goBack();
    } }, sku.category_name), /* @__PURE__ */ React.createElement("span", { className: "pdp-crumb" })), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-900)" } }, fullProductName(sku))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main", ref: sectionRefs.details }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery", ref: galleryRef }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-image" }, mainImage && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(mainImage.url, 800), ...optimizeSrcSet(mainImage.url, [400, 600, 800, 1200]), sizes: "(max-width: 768px) 100vw, 50vw", alt: sku.product_name, fetchPriority: "high", decoding: "async" })), images.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "gallery-thumbs" }, images.map((img, i) => {
      return /* @__PURE__ */ React.createElement("div", { key: img.id, className: "gallery-thumb" + (i === selectedImage ? " active" : ""), onClick: () => setSelectedImage(i) }, /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(img.url, 120), alt: "", loading: "lazy", decoding: "async", width: "80", height: "80" }));
    })), (() => {
      const HIDDEN_SLUGS = /* @__PURE__ */ new Set(["price_list", "material_class", "style_code", "companion_skus", "subcategory", "msrp", "top_ref_sku", "sink_ref_sku", "optional_accessories", "group_number"]);
      const ORDER = ["_collection", "_category", "_sku", "collection", "species", "color", "color_code", "brand", "application", "fiber", "material", "construction", "finish", "style", "pattern", "size", "thickness", "width", "wear_layer", "weight", "weight_per_sqyd", "roll_width", "roll_length"];
      const slugMap = {};
      (sku.attributes || []).forEach((a) => {
        slugMap[a.slug] = (a.value || "").trim();
      });
      const redundantSlugs = /* @__PURE__ */ new Set();
      if (slugMap.roll_width) {
        redundantSlugs.add("width");
        redundantSlugs.add("size");
      }
      if (slugMap.fiber) redundantSlugs.add("material");
      const visible = (sku.attributes || []).filter((a) => !HIDDEN_SLUGS.has(a.slug) && !redundantSlugs.has(a.slug) && !(a.slug === "species" && /^\d+$/.test(a.value)));
      const seenVals = /* @__PURE__ */ new Map();
      const deduped = visible.filter((a) => {
        const norm = (a.value || "").toUpperCase().replace(/[\s.]+/g, "").trim();
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
        const collectionVal = sku.collection && sku.category_name && sku.collection === sku.category_name ? sku.product_name : sku.collection;
        if (collectionVal) sorted.unshift({ slug: "_collection", name: "Collection", value: collectionVal });
      }
      const injectedCollection = sorted.find((a) => a.slug === "_collection");
      if (sku.category_name && (!injectedCollection || injectedCollection.value !== sku.category_name)) {
        const insertIdx = injectedCollection ? 1 : 0;
        sorted.splice(insertIdx, 0, { slug: "_category", name: "Category", value: sku.category_name });
      }
      if (sku.vendor_sku) {
        const afterCat = sorted.findIndex((a) => a.slug === "_category");
        sorted.splice(afterCat >= 0 ? afterCat + 1 : injectedCollection ? 1 : 0, 0, { slug: "_sku", name: "SKU", value: (sku.vendor_sku || "").toUpperCase() });
      }
      const priceListAttr = (sku.attributes || []).find((a) => a.slug === "price_list");
      if (priceListAttr && priceListAttr.value && !slugMap.brand) {
        const brandLine = priceListAttr.value.replace(/\s+\d+$/, "");
        const ccIdx = sorted.findIndex((a) => a.slug === "color_code");
        sorted.splice(ccIdx >= 0 ? ccIdx + 1 : sorted.length, 0, { slug: "_brand", name: "Brand", value: brandLine });
      }
      if (sorted.length === 0) return null;
      return /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "pdp-section-label" }, "Specifications"), /* @__PURE__ */ React.createElement("table", { className: "specs-table" }, /* @__PURE__ */ React.createElement("tbody", null, sorted.map((a, i) => /* @__PURE__ */ React.createElement("tr", { key: i }, /* @__PURE__ */ React.createElement("td", null, a.name), /* @__PURE__ */ React.createElement("td", null, a.slug === "_sku" ? a.value : formatCarpetValue(a.value)))))));
    })(), (sku.description_long || sku.description_short) && (() => {
      const cleaned = cleanDescription(sku.description_long || sku.description_short, sku.brand_name || sku.vendor_name);
      return cleaned ? /* @__PURE__ */ React.createElement("div", { className: "pdp-desc-section" }, /* @__PURE__ */ React.createElement("div", { className: "pdp-desc-label" }, "About this product"), /* @__PURE__ */ React.createElement("p", { className: "pdp-description" }, cleaned)) : null;
    })(), specPdfs.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "pdp-docs-section" }, /* @__PURE__ */ React.createElement("div", { className: "pdp-docs-label" }, "Documentation"), /* @__PURE__ */ React.createElement("div", { className: "pdp-pdf-grid" }, specPdfs.map((pdf) => /* @__PURE__ */ React.createElement("a", { key: pdf.id, href: pdf.url, target: "_blank", rel: "noopener noreferrer", className: "pdp-pdf-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 18, height: 18 } }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "18", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 15 12 18 15 15" })), /* @__PURE__ */ React.createElement("span", null, (() => {
      const fn = (pdf.url || "").split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      return fn.length > 3 ? fn.replace(/\b\w/g, (c) => c.toUpperCase()) : "Spec Sheet";
    })(), /* @__PURE__ */ React.createElement("span", { className: "pdp-pdf-type" }, "PDF"))))))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info", ref: infoRef }, /* @__PURE__ */ React.createElement("div", { className: "pdp-category-label" }, sku.category_name, sku.collection && sku.collection !== sku.category_name && sku.collection !== sku.vendor_name && sku.collection !== sku.brand_name ? " \xB7 " + sku.collection : ""), /* @__PURE__ */ React.createElement("div", { className: "pdp-title-row" }, /* @__PURE__ */ React.createElement("h1", { className: "sku-detail-title-row" }, cleanProductTitle(sku.product_name, sku) || fullProductName(sku)), /* @__PURE__ */ React.createElement("button", { className: "pdp-wishlist-heart" + (wishlist.includes(sku.sku_id) ? " active" : ""), onClick: () => toggleWishlist2(sku.sku_id), "aria-label": wishlist.includes(sku.sku_id) ? "Remove from wishlist" : "Add to wishlist" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: wishlist.includes(sku.sku_id) ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 18, height: 18 } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })))), (sku.variant_name || sku.attributes && sku.attributes.length > 0) && /* @__PURE__ */ React.createElement("div", { className: "pdp-variant-name" }, pdpSubtitle(sku)), /* @__PURE__ */ React.createElement("div", { className: "pdp-sku-line" }, sku.vendor_sku && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)" } }, "SKU"), " ", /* @__PURE__ */ React.createElement("span", { style: { margin: "0 0.25rem", color: "var(--stone-400)" } }, "\xB7"), " ", /* @__PURE__ */ React.createElement("span", { className: "pdp-sku-val" }, (sku.vendor_sku || "").toUpperCase()), /* @__PURE__ */ React.createElement("span", { className: "pdp-sku-sep" })), /* @__PURE__ */ React.createElement("span", null, sku.vendor_name || sku.brand_name || "")), productTags.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "product-tag-badges" }, productTags.map((t) => /* @__PURE__ */ React.createElement("span", { key: t.slug, className: "product-tag-badge" }, t.name))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-price" }, isCarpet(sku) ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "pdp-price-main" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-price-amount" }, "$", parseFloat(sku.cut_price).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-suffix" }, "/sqyd \xB7 $", carpetSqftPrice(sku.cut_price), "/sqft"), tradePrice && /* @__PURE__ */ React.createElement("span", { className: "pdp-price-badge trade" }, "Trade")), sku.roll_price && parseFloat(sku.roll_price) < parseFloat(sku.cut_price) && /* @__PURE__ */ React.createElement("div", { className: "pdp-price-roll-badge" }, "Roll $", parseFloat(sku.roll_price).toFixed(2), "/sqyd", sku.roll_min_sqft ? " \xB7 " + parseFloat(sku.roll_min_sqft).toFixed(0) + " sqft min" : "")) : tradePrice ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "pdp-price-main" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-price-amount" }, "$", tradePrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-suffix" }, priceSuffix(sku)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-strike" }, "$", retailPrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-badge trade" }, "Trade")), !isPerUnit && sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "pdp-price-per-box" }, "$", (tradePrice * sqftPerBox).toFixed(2), " per ", boxLabel, " \xB7 ", sqftPerBox, " sqft", sku.pieces_per_box ? " \xB7 " + sku.pieces_per_box + " pieces" : "")) : salePrice ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "pdp-price-main" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-price-amount" }, "$", salePrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-suffix" }, priceSuffix(sku)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-strike" }, "$", retailPrice.toFixed(2)), retailPrice > 0 && /* @__PURE__ */ React.createElement("span", { className: "pdp-price-badge sale" }, Math.round((1 - salePrice / retailPrice) * 100), "% off")), !isPerUnit && sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "pdp-price-per-box" }, "$", (salePrice * sqftPerBox).toFixed(2), " per ", boxLabel, " \xB7 ", sqftPerBox, " sqft", sku.pieces_per_box ? " \xB7 " + sku.pieces_per_box + " pieces" : "")) : retailPrice > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "pdp-price-main" }, msrpPrice && msrpPrice > retailPrice && /* @__PURE__ */ React.createElement("span", { className: "pdp-price-strike" }, "$", msrpPrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-amount" }, "$", retailPrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "pdp-price-suffix" }, priceSuffix(sku))), !isPerUnit && sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "pdp-price-per-box" }, "$", (retailPrice * sqftPerBox).toFixed(2), " per ", boxLabel, " \xB7 ", sqftPerBox, " sqft", sku.pieces_per_box ? " \xB7 " + sku.pieces_per_box + " pieces" : "")) : /* @__PURE__ */ React.createElement("div", { className: "pdp-price-main" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-price-amount", style: { fontSize: "1.5rem" } }, "Call for Price"))), (() => {
      const effUnit = tradePrice || salePrice || retailPrice || 0;
      const isBoxPriced = !isPerUnit && sqftPerBox > 0 && !isCarpet(sku);
      const klarnaBase = isCarpet(sku) ? parseFloat(sku.cut_price) || 0 : isBoxPriced ? effUnit * sqftPerBox : effUnit;
      if (!(klarnaBase >= 35)) return null;
      const unitLabel = isCarpet(sku) ? "sq yd" : isBoxPriced ? boxLabel : "item";
      return /* @__PURE__ */ React.createElement("div", { className: "pdp-klarna" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-klarna-icon" }, "Klarna."), /* @__PURE__ */ React.createElement("span", { className: "pdp-klarna-text" }, "4 interest-free payments of ", /* @__PURE__ */ React.createElement("strong", null, "$", (klarnaBase / 4).toFixed(2)), " per ", unitLabel, ". No fees."));
    })(), isCarpetSku && (() => {
      const attrMap = {};
      (sku.attributes || []).forEach((a) => {
        attrMap[a.slug] = a.value;
      });
      const specs = [
        attrMap.collection && { label: "Collection", value: formatCarpetValue(attrMap.collection) },
        attrMap.fiber && { label: "Fiber", value: formatCarpetValue(attrMap.fiber) },
        attrMap.construction && { label: "Construction", value: formatCarpetValue(attrMap.construction) },
        rollWidthFt > 0 && { label: "Roll Width", value: rollWidthFt + " ft" }
      ].filter(Boolean);
      if (specs.length === 0) return null;
      return /* @__PURE__ */ React.createElement("div", { className: "carpet-specs-band" }, specs.map((s, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "carpet-spec-card" }, /* @__PURE__ */ React.createElement("div", { className: "carpet-spec-card-label" }, s.label), /* @__PURE__ */ React.createElement("div", { className: "carpet-spec-card-value" }, s.value))));
    })(), (() => {
      const isSlab = /slab|countertop/i.test(sku.category_name || "") || /slab/i.test(sku.variant_name || "") || /slab/i.test(sku.product_name || "");
      if (!isSlab) return null;
      const sa = {};
      (sku.attributes || []).forEach((a) => {
        sa[a.slug] = a.value;
      });
      const size = sa.size;
      const thickness = sa.thickness;
      if (!size && !thickness) return null;
      const dims = [];
      if (size && size !== "Variable") {
        const parts = size.replace(/ Slab$/i, "").split("x");
        if (parts.length === 2) dims.push({ label: "Slab Size", value: parts[0].trim() + '" \xD7 ' + parts[1].trim() + '"' });
        else dims.push({ label: "Slab Size", value: size });
      } else if (size === "Variable") {
        dims.push({ label: "Slab Size", value: "Variable (natural stone)" });
      }
      if (thickness) dims.push({ label: "Thickness", value: thickness });
      if (dims.length === 0) return null;
      return /* @__PURE__ */ React.createElement("div", { className: "carpet-specs-band" }, dims.map((d, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "carpet-spec-card" }, /* @__PURE__ */ React.createElement("div", { className: "carpet-spec-card-label" }, d.label), /* @__PURE__ */ React.createElement("div", { className: "carpet-spec-card-value" }, d.value))));
    })(), (() => {
      const currentAttrs = (sku.attributes || []).reduce((m, a) => {
        m[a.slug] = a.value;
        return m;
      }, {});
      const allSiblings = [{ sku_id: sku.sku_id, variant_name: sku.variant_name, attributes: sku.attributes || [], primary_image: media && media[0] ? media[0].url : null }, ...mainSiblings];
      if (isAdexProduct) {
        const allCollection = [];
        const seenIds = /* @__PURE__ */ new Set();
        const curColorAttr = (sku.attributes || []).find((a) => a.slug === "color");
        const curColor = curColorAttr ? curColorAttr.value : "";
        const curFinishAttr = (sku.attributes || []).find((a) => a.slug === "finish");
        const curFinish = curFinishAttr ? curFinishAttr.value : "";
        const curSkuPrimary = media ? media.find((m) => m.sku_id && m.asset_type === "primary") : null;
        const curSizeAttr = (sku.attributes || []).find((a) => a.slug === "size");
        const curSize = curSizeAttr ? curSizeAttr.value : "";
        allCollection.push({
          sku_id: sku.sku_id,
          product_name: sku.product_name,
          variant_name: sku.variant_name,
          primary_image: curSkuPrimary ? curSkuPrimary.url : null,
          color: curColor,
          finish: curFinish,
          size: curSize
        });
        seenIds.add(sku.sku_id);
        mainSiblings.forEach((s) => {
          if (seenIds.has(s.sku_id)) return;
          seenIds.add(s.sku_id);
          allCollection.push({ ...s, product_name: sku.product_name, color: s.color || ((s.attributes || []).find((a) => a.slug === "color") || {}).value || "", finish: s.finish || ((s.attributes || []).find((a) => a.slug === "finish") || {}).value || "", size: s.size || ((s.attributes || []).find((a) => a.slug === "size") || {}).value || "", primary_image: s.sku_image || null });
        });
        collectionSiblings.forEach((s) => {
          if (seenIds.has(s.sku_id)) return;
          seenIds.add(s.sku_id);
          allCollection.push({ ...s, color: s.color || "", finish: s.finish || "" });
        });
        if (allCollection.length > 1) {
          const isMainVariant = (s) => {
            const vn = s.variant_name || "";
            return !/^(End Cap|Frame Corner|Beak|FE Corner)\s*-/i.test(vn);
          };
          const sameProductFinish = allCollection.filter(
            (s) => s.product_name === sku.product_name && s.finish === curFinish && isMainVariant(s)
          );
          const uniqueColors = [...new Set(sameProductFinish.map((s) => s.color))].filter(Boolean).sort();
          const colorSwatches = uniqueColors.map((color) => {
            const rep = sameProductFinish.find((s) => s.color === color && s.size === curSize) || sameProductFinish.find((s) => s.color === color);
            return { color, sku_id: rep.sku_id, primary_image: rep.primary_image, is_current: color === curColor };
          });
          const sameProductColor = allCollection.filter(
            (s) => s.product_name === sku.product_name && s.color === curColor && isMainVariant(s)
          );
          const finishesForColor = [...new Set(sameProductColor.map((s) => s.finish))].sort();
          const showFinishRow = finishesForColor.length > 1;
          const matchingVariants = allCollection.filter((s) => s.color === curColor && s.finish === curFinish && s.sku_id !== sku.sku_id);
          return /* @__PURE__ */ React.createElement("div", { className: "variant-selectors" }, uniqueColors.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Color", /* @__PURE__ */ React.createElement("span", null, curColor)), /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, colorSwatches.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.color, className: "color-swatch-wrap", onClick: () => {
            if (!c.is_current) onSkuClick(c.sku_id);
          } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (c.is_current ? " active" : "") }, c.primary_image ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(c.primary_image, 120), alt: c.color, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: 600, color: "var(--stone-500)", textAlign: "center", lineHeight: 1.2, padding: "4px" } }, c.color)), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, c.color))))), showFinishRow && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Finish", /* @__PURE__ */ React.createElement("span", null, curFinish || "Standard")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, finishesForColor.map((f) => {
            const isActive = f === curFinish;
            const match = sameProductColor.find((s) => s.finish === f && s.size === curSize) || sameProductColor.find((s) => s.finish === f) || allCollection.find((s) => s.color === curColor && s.finish === f && s.product_name === sku.product_name);
            return /* @__PURE__ */ React.createElement("button", { key: f || "_std", className: "attr-pill" + (isActive ? " active" : ""), onClick: () => {
              if (!isActive && match) onSkuClick(match.sku_id);
            } }, f || "Standard");
          }))), matchingVariants.length > 0 && (() => {
            const categorize = (name, variantName) => {
              const vn = variantName || "";
              const dashIdx = vn.indexOf(" - ");
              const prefix = dashIdx > 0 ? vn.substring(0, dashIdx) : "";
              if (/^End Cap|^Frame Corner/i.test(prefix)) return "Finishing Touches";
              if (/^Beak/i.test(prefix)) return "Decorative Accessories";
              if (/^FE Corner/i.test(prefix)) return "Finishing Edges";
              if (/^Field Tile/i.test(name)) return "Field Tiles";
              if (/^Beveled/i.test(name)) return "Beveled Tiles";
              if (/Stripe Liner|Quarter Round|Round Bar|Ponciana/i.test(name)) return "Decorative Accessories";
              if (/Finishing Edge|^FE /i.test(name)) return "Finishing Edges";
              if (/^Sbn |^Dbn /i.test(name)) return "Bullnoses";
              if (/^Dge |^Sge |^Framed/i.test(name)) return "Glazed Edges";
              if (/Chair Molding|Crown Molding|Rail Molding|Base Board|Molding/i.test(name)) return "Moldings & Trim";
              if (/Deco|Border|Liner|Listello|Planet|Universe|Vizcaya|Flower|Gables|Palm Beach/i.test(name)) return "Decorative Accents";
              return "Other Pieces";
            };
            const displayName = (s) => {
              const vn = s.variant_name || "";
              const dashIdx = vn.indexOf(" - ");
              const prefix = dashIdx > 0 ? vn.substring(0, dashIdx) : "";
              let name = s.product_name;
              if (/^End Cap|^Frame Corner|^Beak|^FE Corner/i.test(prefix)) name = s.product_name + " \u2014 " + prefix;
              if (s.size) name += " " + s.size;
              return name;
            };
            const groups = {};
            matchingVariants.forEach((s) => {
              const cat = categorize(s.product_name || "", s.variant_name || "");
              if (!groups[cat]) groups[cat] = [];
              groups[cat].push(s);
            });
            const CATEGORY_ORDER = ["Field Tiles", "Beveled Tiles", "Decorative Accessories", "Decorative Accents", "Finishing Edges", "Bullnoses", "Glazed Edges", "Moldings & Trim", "Finishing Touches", "Other Pieces"];
            const orderedGroups = CATEGORY_ORDER.filter((cat) => groups[cat] && groups[cat].length > 0);
            return /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label", style: { marginBottom: "0.75rem" } }, curColor, curFinish ? " " + curFinish : "", " \u2014 ", sku.collection, " Collection", /* @__PURE__ */ React.createElement("span", null, matchingVariants.length, " pieces")), orderedGroups.map((cat) => {
              const MAX_VISIBLE = 12;
              const items = groups[cat];
              const isExpanded = expandedAdexCats.has(cat);
              const visibleItems = isExpanded ? items : items.slice(0, MAX_VISIBLE);
              const hasMore = items.length > MAX_VISIBLE;
              return /* @__PURE__ */ React.createElement("div", { key: cat, style: { marginBottom: "1.25rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--stone-500)", marginBottom: "0.5rem" } }, cat), /* @__PURE__ */ React.createElement("div", { className: "variant-grid" }, visibleItems.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, getVariantImage(s) && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(getVariantImage(s), 120), alt: displayName(s), loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, displayName(s)), skuListPrice(s) && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(s, skuListPrice(s)).toFixed(2), priceSuffix(s))))), hasMore && !isExpanded && /* @__PURE__ */ React.createElement("button", { className: "show-more-btn", onClick: () => setExpandedAdexCats((prev) => /* @__PURE__ */ new Set([...prev, cat])) }, "Show all ", items.length, " pieces"));
            }));
          })());
        }
      }
      const normColor = (v) => (v || "").replace(/\s*\d+\.?\d*\s*[xX]+\s*\d+\.?\d*\s*/g, " ").replace(/\s*-?\s*\d+m[mi]l?\b/gi, "").replace(/^\s*-\s*/, "").replace(/\s+/g, " ").trim();
      let colorItems = [];
      const currentColorVal = currentAttrs["color"];
      const currentSizeVal = currentAttrs["size"];
      const normalizedCurrentColor = normColor(currentColorVal);
      const distinctSiblingColors = new Set(
        mainSiblings.map((s) => (s.attributes || []).find((a) => a.slug === "color")).filter(Boolean).map((a) => normColor(a.value))
      );
      const allNormalizedColors = new Set(
        normalizedCurrentColor ? [normalizedCurrentColor, ...distinctSiblingColors] : [...distinctSiblingColors]
      );
      if (normalizedCurrentColor && allNormalizedColors.size > 1) {
        const byColor = /* @__PURE__ */ new Map();
        byColor.set(normalizedCurrentColor, {
          sku_id: sku.sku_id,
          product_name: normalizedCurrentColor,
          primary_image: media && media[0] ? media[0].url : null,
          is_current: true
        });
        mainSiblings.forEach((s) => {
          const attrs = s.attributes || [];
          const ca = attrs.find((a) => a.slug === "color");
          const sa = attrs.find((a) => a.slug === "size");
          if (!ca) return;
          const color = normColor(ca.value);
          if (color === normalizedCurrentColor) return;
          const existing = byColor.get(color);
          const matchesCurrentSize = sa && sa.value === currentSizeVal;
          if (!existing || matchesCurrentSize && !existing._sizeMatched) {
            byColor.set(color, {
              sku_id: s.sku_id,
              product_name: color,
              primary_image: getVariantImage(s),
              is_current: false,
              _sizeMatched: !!matchesCurrentSize
            });
          }
        });
        colorItems = [...byColor.values()].sort((a, b) => (a.product_name || "").localeCompare(b.product_name || ""));
      }
      const _isDecorativeHW = (sku.vendor_code || "").toUpperCase() === "ROM440";
      let collectionSizeItems = [];
      if (collectionSiblings.length > 0) {
        const extractDims = (name) => {
          const m = (name || "").match(/(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/);
          if (m) return m[0];
          const s = (name || "").match(/\b(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*["″]/);
          return s ? s[0] : null;
        };
        const extractFinish = (name) => {
          const m = (name || "").match(/,\s*(.+?)(?:\s*\(|$)/);
          return m ? m[1].trim() : null;
        };
        const extractSort = (sz) => {
          const n = parseFractionalInches(sz);
          if (!isNaN(n)) return n;
          const m = (sz || "").match(/(\d+)/);
          return m ? parseFloat(m[1]) : 0;
        };
        const curSz = extractDims(sku.product_name);
        const curFinishVal = extractFinish(sku.product_name);
        const allItems = [{ product_name: sku.product_name, sku_id: sku.sku_id, primary_image: media && media[0] ? media[0].url : null }, ...collectionSiblings];
        const comboMap = /* @__PURE__ */ new Map();
        const imgMap = /* @__PURE__ */ new Map();
        allItems.forEach((s) => {
          const sz = extractDims(s.product_name);
          const fn = extractFinish(s.product_name);
          if (sz && fn) comboMap.set(sz + "|" + fn, s.sku_id);
          if (s.primary_image) imgMap.set(s.sku_id, s.primary_image);
        });
        if (curSz) {
          const sizeMap = /* @__PURE__ */ new Map();
          allItems.forEach((s) => {
            const sz = extractDims(s.product_name);
            if (!sz) return;
            const nk = normalizeSize(sz);
            if (sizeMap.has(nk)) return;
            const target = comboMap.get(sz + "|" + curFinishVal) || s.sku_id;
            sizeMap.set(nk, { label: formatSizeDim(sz), sku_id: target, is_current: normalizeSize(sz) === normalizeSize(curSz), sort: extractSort(sz), primary_image: imgMap.get(target) || s.primary_image || null });
          });
          if (sizeMap.size > 1) {
            collectionSizeItems = [...sizeMap.values()].sort((a, b) => a.sort - b.sort);
          }
        }
      }
      const showSizePills = collectionSizeItems.length > 0;
      let collectionFinishItems = [];
      if (collectionSiblings.length > 0) {
        const extractDims2 = (name) => {
          const m = (name || "").match(/(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/);
          return m ? m[0] : null;
        };
        const extractFinish2 = (name) => {
          const m = (name || "").match(/,\s*(.+?)(?:\s*\(|$)/);
          return m ? m[1].trim() : null;
        };
        const curSz2 = extractDims2(sku.product_name);
        const curFn = extractFinish2(sku.product_name);
        const allItems2 = [{ product_name: sku.product_name, sku_id: sku.sku_id }, ...collectionSiblings];
        const comboMap2 = /* @__PURE__ */ new Map();
        allItems2.forEach((s) => {
          const sz = extractDims2(s.product_name);
          const fn = extractFinish2(s.product_name);
          if (sz && fn) comboMap2.set(sz + "|" + fn, s.sku_id);
        });
        if (curFn) {
          const finishMap = /* @__PURE__ */ new Map();
          allItems2.forEach((s) => {
            const fn = extractFinish2(s.product_name);
            if (!fn || finishMap.has(fn)) return;
            const target = comboMap2.get(curSz2 + "|" + fn) || s.sku_id;
            finishMap.set(fn, { label: fn, sku_id: target, is_current: fn === curFn });
          });
          if (finishMap.size > 1) {
            collectionFinishItems = [...finishMap.values()];
          }
        }
      }
      if (collectionAttributes.finish && (collectionAttributes.finish.values || []).length >= 2 && collectionSiblings.length > 0) {
        const existingFinishes = new Set(collectionFinishItems.map((f) => f.label));
        const curSize = currentAttrs["size"] || "";
        const curFinish2 = currentAttrs["finish"] || "";
        if (curFinish2 && !existingFinishes.has(curFinish2)) {
          collectionFinishItems.push({ label: curFinish2, sku_id: sku.sku_id, is_current: true });
          existingFinishes.add(curFinish2);
        }
        (collectionAttributes.finish.values || []).forEach((fn) => {
          if (existingFinishes.has(fn)) return;
          const sameProductMatch = mainSiblings.find((s) => {
            const fAttr = (s.attributes || []).find((a) => a.slug === "finish");
            return fAttr && fAttr.value === fn;
          });
          if (sameProductMatch) {
            collectionFinishItems.push({ label: fn, sku_id: sameProductMatch.sku_id, is_current: false });
            return;
          }
          let targetSkuId = null;
          for (const cs of collectionSiblings) {
            if (!cs.sku_map) continue;
            for (const [key, sid] of Object.entries(cs.sku_map)) {
              const parts = key.split("|");
              if (parts[1] !== fn) continue;
              if (curSize && normalizeSize(parts[0]) === normalizeSize(curSize)) {
                targetSkuId = sid;
                break;
              }
              if (!targetSkuId) targetSkuId = sid;
            }
            if (targetSkuId) break;
          }
          if (targetSkuId) {
            collectionFinishItems.push({ label: fn, sku_id: targetSkuId, is_current: false, is_cross_product: true });
          }
        });
      }
      const _hasCountertopFinish = (sku.attributes || []).some((a) => a.slug === "countertop_finish") || allSiblings.some((s) => (s.attributes || []).some((a) => a.slug === "countertop_finish"));
      const showFinishPills = collectionFinishItems.length > 0 && !_isDecorativeHW && !_hasCountertopFinish;
      let sibSizeItems = [];
      if (mainSiblings.length > 0 && !showSizePills) {
        const _getWidthRaw = (attrs) => {
          const ol = (attrs || []).find((a) => a.slug === "overall_length");
          if (ol) return ol.value;
          const wa = (attrs || []).find((a) => a.slug === "width");
          return wa ? wa.value : null;
        };
        const _getWidthNum = (attrs, vn) => {
          const raw = _getWidthRaw(attrs);
          if (raw) return parseFractionalInches(raw);
          const m = (vn || "").match(/\b(\d+(?:[-\s]\d+\/\d+)?\.?\d*)\s*["″]/);
          return m ? parseFractionalInches(m[1]) : null;
        };
        const _getSize = (attrs) => {
          const sa = (attrs || []).find((a) => a.slug === "size");
          return sa ? sa.value : null;
        };
        const _extractColor = (attrs, vn) => {
          const idx = (vn || "").lastIndexOf(",");
          if (idx > 0) return vn.substring(idx + 1).trim();
          const ca = (attrs || []).find((a) => a.slug === "color");
          if (ca) return ca.value;
          return null;
        };
        const curW = _getWidthNum(sku.attributes, sku.variant_name);
        const curWRaw = _getWidthRaw(sku.attributes);
        const curC = _extractColor(sku.attributes, sku.variant_name);
        const curSz = _getSize(sku.attributes);
        const dimItems = [{ sku_id: sku.sku_id, w: curW, wRaw: curWRaw, sz: curSz, c: curC, img: media && media[0] ? media[0].url : null, is_current: true }];
        mainSiblings.forEach((s) => {
          dimItems.push({ sku_id: s.sku_id, w: _getWidthNum(s.attributes, s.variant_name), wRaw: _getWidthRaw(s.attributes), sz: _getSize(s.attributes), c: _extractColor(s.attributes, s.variant_name), img: getVariantImage(s), is_current: false });
        });
        const uniqueWidths = new Set(dimItems.filter((d) => d.w != null && !isNaN(d.w)).map((d) => d.w));
        if (uniqueWidths.size > 1 && curW != null) {
          const sizeMap = /* @__PURE__ */ new Map();
          dimItems.forEach((d) => {
            if (d.w == null || isNaN(d.w)) return;
            const ex = sizeMap.get(d.w);
            if (!ex || d.is_current || !ex.is_current && d.c === curC && !ex._cm) {
              sizeMap.set(d.w, { ...d, _cm: d.c === curC });
            }
          });
          sibSizeItems = [...sizeMap.values()].map((d) => ({ label: d.sz ? formatSizeDim(d.sz) : d.wRaw || d.w + "\u2033", sku_id: d.sku_id, is_current: d.w === curW, sort: d.w, primary_image: d.img })).sort((a, b) => a.sort - b.sort);
          if (colorItems.length > 0) {
            const availableAtWidth = new Set(dimItems.filter((d) => d.w === curW && d.c).map((d) => normColor(d.c)));
            colorItems = colorItems.filter((c) => c.is_current || availableAtWidth.has(normColor(c.product_name)));
            colorItems = colorItems.map((c) => {
              if (c.is_current) return c;
              const match = dimItems.find((d) => d.w === curW && normColor(d.c) === normColor(c.product_name));
              return match ? { ...c, sku_id: match.sku_id, primary_image: match.img || c.primary_image } : c;
            });
            if (colorItems.length <= 1) {
              colorItems = [];
              var _widthCleared = true;
            }
          }
        }
        const _hasColorAttr = (sku.attributes || []).some((a) => a.slug === "color");
        if (colorItems.length === 0 && curC && uniqueWidths.size >= 1 && (_widthCleared || !_hasColorAttr)) {
          const forColors = sibSizeItems.length > 0 && curW ? dimItems.filter((d) => d.w === curW) : dimItems;
          const colorMap = /* @__PURE__ */ new Map();
          forColors.forEach((d) => {
            if (d.c && !colorMap.has(d.c)) {
              colorMap.set(d.c, { sku_id: d.sku_id, product_name: d.c, primary_image: d.img, is_current: d.is_current });
            }
          });
          if (colorMap.size > 1) {
            colorItems = [...colorMap.values()].sort((a, b) => (a.product_name || "").localeCompare(b.product_name || ""));
          }
        }
      }
      const showSibSizes = sibSizeItems.length > 0;
      let attrSizeItems = [];
      if (!showSizePills && sibSizeItems.length === 0 && mainSiblings.length > 0) {
        const _getSizeAttr = (attrs) => {
          const sa = (attrs || []).find((a) => a.slug === "size");
          return sa ? sa.value : null;
        };
        const curSizeVal = _getSizeAttr(sku.attributes);
        const dimRe = /(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/;
        if (curSizeVal && dimRe.test(curSizeVal)) {
          const sizeMap = /* @__PURE__ */ new Map();
          sizeMap.set(normalizeSize(curSizeVal), { label: formatSizeDim(curSizeVal), sku_id: sku.sku_id, is_current: true, sort: parseFractionalInches(curSizeVal.match(dimRe)[1]) });
          mainSiblings.forEach((s) => {
            if (s.variant_type === "accessory") return;
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
      if (!showSizePills && sibSizeItems.length === 0 && collectionAttributes.size && (collectionAttributes.size.values || []).length >= 2) {
        const _csa = (attrs) => {
          const sa = (attrs || []).find((a) => a.slug === "size");
          return sa ? sa.value : null;
        };
        let curSz = _csa(sku.attributes);
        const _dimRe = /(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)\s*[xX×]\s*(\d+(?:[-\s]\d+\/\d+|\.\d+|\/\d+)?)/;
        if (!curSz) {
          const vnMatch = (sku.variant_name || "").match(_dimRe);
          if (vnMatch) {
            const vnNorm = normalizeSize(vnMatch[0]);
            const fullVal = (collectionAttributes.size.values || []).find((sv) => normalizeSize(sv).startsWith(vnNorm));
            curSz = fullVal || vnMatch[0];
          }
        }
        if (curSz) {
          const sizeMap = /* @__PURE__ */ new Map();
          if (attrSizeItems.length > 0) {
            attrSizeItems.forEach((item) => {
              sizeMap.set(normalizeSize(item.label.replace(/[″″"]/g, "").replace(/\s*×\s*/g, "x").trim()), item);
            });
          } else {
            const dm = curSz.match(_dimRe);
            if (dm) sizeMap.set(normalizeSize(curSz), { label: formatSizeDim(curSz), sku_id: sku.sku_id, is_current: true, sort: parseFractionalInches(dm[1]) });
            mainSiblings.forEach((s) => {
              if (s.variant_type === "accessory") return;
              const sv = _csa(s.attributes);
              if (!sv) return;
              const nk = normalizeSize(sv);
              if (sizeMap.has(nk)) return;
              const dm2 = sv.match(_dimRe);
              if (!dm2) return;
              sizeMap.set(nk, { label: formatSizeDim(sv), sku_id: s.sku_id, is_current: false, sort: parseFractionalInches(dm2[1]) });
            });
          }
          const curFinish = currentAttrs["finish"] || "";
          (collectionAttributes.size.values || []).forEach((sv) => {
            const nk = normalizeSize(sv);
            if (sizeMap.has(nk)) return;
            const dm = sv.match(_dimRe);
            if (!dm) return;
            let targetSkuId = null;
            for (const cs of collectionSiblings) {
              if (!cs.sku_map) continue;
              for (const [key, sid] of Object.entries(cs.sku_map)) {
                const parts = key.split("|");
                if (normalizeSize(parts[0]) === nk) {
                  if (curFinish && parts[1] === curFinish) {
                    targetSkuId = sid;
                    break;
                  }
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
      if (colorItems.length <= 1 && collectionSiblings.length > 0) {
        const nonAccSiblings = collectionSiblings.filter((s) => s.variant_type !== "accessory");
        if (nonAccSiblings.length > 0) {
          colorItems = [
            { sku_id: sku.sku_id, product_name: sku.product_name, variant_name: sku.variant_name, color: currentColorVal, primary_image: media && media[0] ? media[0].url : null, is_current: true },
            ...nonAccSiblings
          ].sort((a, b) => (a.product_name || "").localeCompare(b.product_name || ""));
        }
      }
      const attrMap = {};
      allSiblings.forEach((s) => {
        (s.attributes || []).forEach((a) => {
          if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: /* @__PURE__ */ new Set() };
          attrMap[a.slug].values.add(a.value);
        });
      });
      const _hasNoCtSibling = attrMap["countertop_finish"] && allSiblings.some((s) => !(s.attributes || []).some((a) => a.slug === "countertop_finish"));
      if (_hasNoCtSibling) {
        attrMap["countertop_finish"].values.add("No Countertop");
        if (!currentAttrs["countertop_finish"]) currentAttrs["countertop_finish"] = "No Countertop";
      }
      const NON_SELECTABLE = /* @__PURE__ */ new Set(["pei_rating", "shade_variation", "water_absorption", "dcof", "material", "material_class", "country", "application", "edge", "look", "color", "color_code", "style_code", "price_list", "companion_skus", "species", "subcategory", "upc", "msrp", "weight", "top_ref_sku", "sink_ref_sku", "optional_accessories", "group_number", "width", "size", "height", "depth", "hardware_finish", "num_drawers", "num_doors", "num_shelves", "num_sinks", "soft_close", "sink_material", "sink_type", "vanity_type", "bowl_shape", "style", "origin", "countertop_material", "construction", "sub_line", "collection", "brand", "surface_texture", "wear_layer", "ac_rating", "edge_treatment", "plank_width", "plank_length", "composition", "install_method", "features", "technology", "product_line", "color_family", "breaking_strength", "mohs_hardness", "color_generic", "pattern", "projection", "clearance", "overall_length", "diameter", "center_to_center"]);
      const curSubLineAttr = (sku.attributes || []).find((a) => a.slug === "sub_line");
      const curSubLine = curSubLineAttr ? curSubLineAttr.value : "";
      const subLineMap = /* @__PURE__ */ new Map();
      allSiblings.forEach((s) => {
        const sla = (s.attributes || []).find((a) => a.slug === "sub_line");
        const sl = sla ? sla.value : "";
        if (sl) {
          if (!subLineMap.has(sl)) subLineMap.set(sl, []);
          subLineMap.set(sl, [...subLineMap.get(sl), s]);
        }
      });
      const subLineValues = [...subLineMap.keys()].sort();
      const showSubLinePill = subLineValues.length > 1;
      const isRomanSubLine = showSubLinePill && subLineValues.every((sl) => /^I{1,3}$/.test(sl));
      const subLineSectionLabel = isRomanSubLine ? "Series" : "Format";
      const subLineLabel = (sl) => {
        if (isRomanSubLine) return sl;
        const short = sl.replace(/^ADURA\s*/i, "");
        const rep = (subLineMap.get(sl) || [])[0];
        if (rep) {
          const thAttr = (rep.attributes || []).find((a) => a.slug === "thickness");
          if (thAttr) return short + " (" + thAttr.value + ")";
        }
        return short;
      };
      if (showSubLinePill && curSubLine && colorItems.length > 0) {
        const subLineSibIds = new Set((subLineMap.get(curSubLine) || []).map((s) => s.sku_id));
        subLineSibIds.add(sku.sku_id);
        colorItems = colorItems.filter((c) => subLineSibIds.has(c.sku_id));
      }
      const effectiveSiblings = showSubLinePill && curSubLine ? allSiblings.filter((s) => {
        const sla = (s.attributes || []).find((a) => a.slug === "sub_line");
        return !sla || sla.value === curSubLine;
      }) : allSiblings;
      if (showSubLinePill && curSubLine) {
        Object.keys(attrMap).forEach((slug) => {
          attrMap[slug].values = /* @__PURE__ */ new Set();
        });
        effectiveSiblings.forEach((s) => {
          (s.attributes || []).forEach((a) => {
            if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: /* @__PURE__ */ new Set() };
            attrMap[a.slug].values.add(a.value);
          });
        });
      }
      const collectionAugmentedSlugs = /* @__PURE__ */ new Set();
      if (collectionSiblings.length > 0 && Object.keys(collectionAttributes).length > 0) {
        Object.entries(collectionAttributes).forEach(([slug, ca]) => {
          if (!ca || !ca.values || ca.values.length < 2) return;
          if (NON_SELECTABLE.has(slug) || slug === "color") return;
          if (!attrMap[slug]) attrMap[slug] = { name: ca.name, values: /* @__PURE__ */ new Set() };
          if (currentAttrs[slug]) attrMap[slug].values.add(currentAttrs[slug]);
          const localCount = attrMap[slug].values.size;
          ca.values.forEach((v) => attrMap[slug].values.add(v));
          if (attrMap[slug].values.size > localCount) collectionAugmentedSlugs.add(slug);
        });
      }
      const FORMAT_QUALIFIERS = [
        { pattern: /\bPaver\b/i, label: "Paver" },
        { pattern: /\bMosaic\b/i, label: "Mosaic" },
        { pattern: /\bTRIM\b/i, label: "Trim" },
        { pattern: /\bLINER\b/i, label: "Liner" },
        { pattern: /\bDeco\b/i, label: "Deco" }
      ];
      const sizeValues = /* @__PURE__ */ new Set();
      effectiveSiblings.forEach((s) => {
        const sa = (s.attributes || []).find((a) => a.slug === "size");
        if (sa) sizeValues.add(sa.value);
      });
      const formatSet = /* @__PURE__ */ new Set();
      let hasStandard = false;
      sizeValues.forEach((val) => {
        const matched = FORMAT_QUALIFIERS.find((q) => q.pattern.test(val));
        if (matched) formatSet.add(matched.label);
        else hasStandard = true;
      });
      const hasFormatPill = formatSet.size > 0 && (hasStandard || formatSet.size > 1);
      const currentSizeRaw = currentAttrs["size"] || "";
      const currentFormatMatch = FORMAT_QUALIFIERS.find((q) => q.pattern.test(currentSizeRaw));
      const currentFormat = currentFormatMatch ? currentFormatMatch.label : hasFormatPill ? "Standard" : null;
      const formatValues = hasFormatPill ? [
        ...hasStandard ? ["Standard"] : [],
        ...[...formatSet].sort()
      ] : [];
      const localAttrCounts = {};
      effectiveSiblings.forEach((s) => {
        (s.attributes || []).forEach((a) => {
          if (!localAttrCounts[a.slug]) localAttrCounts[a.slug] = /* @__PURE__ */ new Set();
          localAttrCounts[a.slug].add(a.value);
        });
        if (_hasNoCtSibling && !(s.attributes || []).some((a) => a.slug === "countertop_finish")) {
          if (!localAttrCounts["countertop_finish"]) localAttrCounts["countertop_finish"] = /* @__PURE__ */ new Set();
          localAttrCounts["countertop_finish"].add("No Countertop");
        }
      });
      collectionAugmentedSlugs.forEach((slug) => {
        if (!localAttrCounts[slug]) localAttrCounts[slug] = /* @__PURE__ */ new Set();
        const ca = collectionAttributes[slug];
        if (ca && ca.values) ca.values.forEach((v) => localAttrCounts[slug].add(v));
      });
      const colorAttrValues = {};
      effectiveSiblings.forEach((s) => {
        const ca = (s.attributes || []).find((a) => a.slug === "color");
        const c = ca && ca.value || s.variant_name || "";
        (s.attributes || []).forEach((a) => {
          if (!colorAttrValues[a.slug]) colorAttrValues[a.slug] = {};
          if (!colorAttrValues[a.slug][c]) colorAttrValues[a.slug][c] = /* @__PURE__ */ new Set();
          colorAttrValues[a.slug][c].add(a.value);
        });
        if (_hasNoCtSibling && !(s.attributes || []).some((a) => a.slug === "countertop_finish")) {
          if (!colorAttrValues["countertop_finish"]) colorAttrValues["countertop_finish"] = {};
          if (!colorAttrValues["countertop_finish"][c]) colorAttrValues["countertop_finish"][c] = /* @__PURE__ */ new Set();
          colorAttrValues["countertop_finish"][c].add("No Countertop");
        }
      });
      const variesWithinColor = (slug) => {
        const byColor = colorAttrValues[slug];
        if (!byColor) return false;
        return Object.values(byColor).some((vals) => vals.size > 1);
      };
      const _finishIsColor = !!attrMap["countertop_finish"];
      const attrSlugs = _isDecorativeHW ? [] : Object.keys(attrMap).filter((slug) => localAttrCounts[slug] && (localAttrCounts[slug].size > 1 || slug === "countertop_finish") && !NON_SELECTABLE.has(slug) && !(slug === "finish" && (showFinishPills || _finishIsColor)) && (slug === "countertop_finish" || collectionAugmentedSlugs.has(slug) || (localAttrCounts[slug].size > 1 ? variesWithinColor(slug) : true))).sort((a, b) => a === "finish" ? -1 : b === "finish" ? 1 : 0);
      const sizeSort = (a, b) => {
        const na = parseFractionalInches(a), nb = parseFractionalInches(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      };
      const showColors = colorItems.length >= 2;
      const isRomanVariants = showColors && colorItems.some((c) => hasRomanSuffix(c.product_name));
      let romanStyleItems = [];
      if (colorItems.length >= 2 && !isRomanVariants && collectionSiblings.length > 0) {
        const curBase = (sku.product_name || "").replace(ROMAN_REGEX, "").replace(/\s+\d+\s*$/, "").trim();
        const romanSibs = collectionSiblings.filter((s) => {
          const sibBase = (s.product_name || "").replace(ROMAN_REGEX, "").replace(/\s+\d+\s*$/, "").trim();
          return sibBase === curBase && (hasRomanSuffix(s.product_name) || s.product_name !== sku.product_name);
        });
        if (romanSibs.length > 0 && (hasRomanSuffix(sku.product_name) || romanSibs.some((s) => hasRomanSuffix(s.product_name)))) {
          const byName = /* @__PURE__ */ new Map();
          byName.set(sku.product_name, { sku_id: sku.sku_id, product_name: sku.product_name, is_current: true });
          romanSibs.forEach((s) => {
            if (!byName.has(s.product_name)) {
              byName.set(s.product_name, { sku_id: s.sku_id, product_name: s.product_name, is_current: false });
            }
          });
          romanStyleItems = [...byName.values()];
        }
      }
      const showRomanStylePills = romanStyleItems.length >= 2;
      const colorLabel = attrMap["countertop_finish"] ? "Cabinet Color" : isRomanVariants ? "Style" : "Color";
      const showAttrs = attrSlugs.length > 0;
      const isColorCompatible = (c) => {
        if (c.is_current) return true;
        const curSize = currentAttrs["size"];
        if (!curSize && attrSlugs.every((s) => !currentAttrs[s])) return true;
        if (c.available_sizes || c.available_finishes) {
          const sizeOk2 = !curSize || !c.available_sizes || c.available_sizes.some((s) => normalizeSize(s) === normalizeSize(curSize));
          const finishOk = _finishIsColor || !currentAttrs["finish"] || !c.available_finishes || c.available_finishes.includes(currentAttrs["finish"]);
          return sizeOk2 && finishOk;
        }
        const targetColor = c.color || c.product_name;
        const sameColorSibs = effectiveSiblings.filter((s) => {
          const ca = (s.attributes || []).find((a) => a.slug === "color");
          return ca && normColor(ca.value) === normColor(targetColor);
        });
        if (sameColorSibs.length === 0) return true;
        const sizeOk = !curSize || sameColorSibs.some((s) => {
          const sa = (s.attributes || []).find((a) => a.slug === "size");
          return sa && normalizeSize(sa.value) === normalizeSize(curSize);
        });
        if (!sizeOk) return false;
        return attrSlugs.every((attrSlug) => {
          const curVal = currentAttrs[attrSlug];
          if (!curVal) return true;
          if (attrSlug === "finish" && _finishIsColor) return true;
          return sameColorSibs.some((s) => {
            const a = (s.attributes || []).find((a2) => a2.slug === attrSlug);
            if (curVal === "No Countertop" && attrSlug === "countertop_finish") return !a;
            return a && a.value === curVal;
          });
        });
      };
      const showFormatSiblings = formatSiblings.length > 0 && formatLabel;
      if (!showColors && !showAttrs && !hasFormatPill && !showSubLinePill && !showRomanStylePills && !showSizePills && !showFinishPills && !showSibSizes && !showAttrSizes && !showFormatSiblings) return null;
      return /* @__PURE__ */ React.createElement("div", { className: "variant-selectors" }, showFormatSiblings && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Style", /* @__PURE__ */ React.createElement("span", null, formatLabel)), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, /* @__PURE__ */ React.createElement("button", { className: "attr-pill active" }, formatLabel), formatSiblings.map((fs) => /* @__PURE__ */ React.createElement("button", { key: fs.sku_id, className: "attr-pill", onClick: () => onSkuClick(fs.sku_id) }, fs.format_label)))), showColors && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, colorLabel, /* @__PURE__ */ React.createElement("span", null, (() => {
        const cur = colorItems.find((c) => c.is_current);
        return cur ? isRomanVariants ? romanPillLabel(cur.product_name) : cur.color || cur.variant_name || cur.product_name : "";
      })())), /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, (isRomanVariants ? [...colorItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)) : colorItems).map((c) => {
        const label = isRomanVariants ? romanPillLabel(c.product_name) : c.color || c.variant_name || c.product_name;
        const compatible = isColorCompatible(c);
        return /* @__PURE__ */ React.createElement("div", { key: c.sku_id, className: "color-swatch-wrap" + (!compatible ? " limited" : ""), onClick: () => {
          if (!c.is_current) onSkuClick(c.sku_id);
        } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (c.is_current ? " active" : "") + (!compatible ? " limited" : "") }, c.primary_image ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(c.primary_image, 120), alt: label, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: 600, color: "var(--stone-500)", textAlign: "center", lineHeight: 1.2, padding: "4px" } }, label)), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, label, !compatible ? " (other options may change)" : ""));
      }))), showSizePills && !attrSlugs.includes("shape") && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Size", /* @__PURE__ */ React.createElement("span", null, collectionSizeItems.find((s) => s.is_current)?.label || "")), sku.vendor_code === "JMV" ? /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, collectionSizeItems.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.label, className: "color-swatch-wrap", onClick: () => {
        if (!s.is_current) onSkuClick(s.sku_id);
      } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (s.is_current ? " active" : "") }, s.primary_image ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 120), alt: s.label, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: 600, color: "var(--stone-500)", textAlign: "center", lineHeight: 1.2, padding: "4px" } }, s.label)), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, s.label)))) : /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, collectionSizeItems.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.label, className: "attr-pill" + (s.is_current ? " active" : ""), onClick: () => {
        if (!s.is_current) onSkuClick(s.sku_id);
      } }, s.label)))), showFinishPills && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Finish", /* @__PURE__ */ React.createElement("span", null, collectionFinishItems.find((s) => s.is_current)?.label || "")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, collectionFinishItems.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.label, className: "attr-pill" + (s.is_current ? " active" : "") + (s.is_cross_product ? " limited" : ""), title: s.is_cross_product ? "Available in other colors" : "", onClick: () => {
        if (!s.is_current && s.sku_id) onSkuClick(s.sku_id);
      } }, s.label)))), showSibSizes && !attrSlugs.includes("shape") && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Size", /* @__PURE__ */ React.createElement("span", null, sibSizeItems.find((s) => s.is_current)?.label || "")), sku.vendor_code === "JMV" ? /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, sibSizeItems.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.label, className: "color-swatch-wrap", onClick: () => {
        if (!s.is_current) onSkuClick(s.sku_id);
      } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (s.is_current ? " active" : "") }, s.primary_image ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 120), alt: s.label, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: 600, color: "var(--stone-500)", textAlign: "center", lineHeight: 1.2, padding: "4px" } }, s.label)), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, s.label)))) : /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, sibSizeItems.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.label, className: "attr-pill" + (s.is_current ? " active" : ""), onClick: () => {
        if (!s.is_current) onSkuClick(s.sku_id);
      } }, s.label)))), showAttrSizes && !attrSlugs.includes("shape") && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Size", /* @__PURE__ */ React.createElement("span", null, attrSizeItems.find((s) => s.is_current)?.label || "")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, attrSizeItems.map((s) => /* @__PURE__ */ React.createElement("button", { key: s.label, className: "attr-pill" + (s.is_current ? " active" : "") + (s.is_cross_product ? " limited" : ""), title: s.is_cross_product ? "Available in other colors" : "", onClick: () => {
        if (!s.is_current && s.sku_id) onSkuClick(s.sku_id);
      } }, s.label)))), showRomanStylePills && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Style", /* @__PURE__ */ React.createElement("span", null, romanPillLabel(sku.product_name))), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, [...romanStyleItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)).map((c) => /* @__PURE__ */ React.createElement("button", { key: c.sku_id, className: "attr-pill" + (c.is_current ? " active" : ""), onClick: () => {
        if (!c.is_current) onSkuClick(c.sku_id);
      } }, romanPillLabel(c.product_name))))), showSubLinePill && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, subLineSectionLabel, /* @__PURE__ */ React.createElement("span", null, curSubLine ? isRomanSubLine ? curSubLine : curSubLine.replace(/^ADURA\s*/i, "") : "")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, subLineValues.map((sl) => {
        const isActive = sl === curSubLine;
        const findSubLineMatch = () => {
          if (isActive) return null;
          const candidates = (subLineMap.get(sl) || []).filter((s) => s.sku_id !== sku.sku_id);
          if (candidates.length === 0) return null;
          const colorMatch = candidates.find((s) => {
            const ca = (s.attributes || []).find((a) => a.slug === "color");
            return ca && ca.value === currentColorVal;
          });
          return colorMatch || candidates[0];
        };
        const best = findSubLineMatch();
        const isDisabled = !isActive && !best;
        return /* @__PURE__ */ React.createElement("button", { key: sl, className: "attr-pill" + (isActive ? " active" : "") + (isDisabled ? " disabled" : ""), onClick: () => {
          if (!isActive && !isDisabled && best) onSkuClick(best.sku_id);
        } }, subLineLabel(sl));
      }))), hasFormatPill && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Format", /* @__PURE__ */ React.createElement("span", null, currentFormat || "")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, formatValues.map((fmt) => {
        const isActive = fmt === currentFormat;
        const findFormatMatch = () => {
          if (isActive) return null;
          const isStd = fmt === "Standard";
          const qualifier = !isStd && FORMAT_QUALIFIERS.find((q) => q.label === fmt);
          const candidates = effectiveSiblings.filter((s) => {
            if (s.sku_id === sku.sku_id) return false;
            const sizeAttr = (s.attributes || []).find((a) => a.slug === "size");
            if (!sizeAttr) return isStd;
            const hasQ = qualifier && qualifier.pattern.test(sizeAttr.value);
            return isStd ? !FORMAT_QUALIFIERS.some((q) => q.pattern.test(sizeAttr.value)) : hasQ;
          });
          if (candidates.length === 0) return null;
          if (candidates.length === 1) return candidates[0];
          const scored = candidates.map((s) => {
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            let score = 0;
            attrSlugs.forEach((k) => {
              if (k !== "size") {
                if (currentAttrs[k] === "No Countertop" && k === "countertop_finish") {
                  if (!sa[k]) score++;
                } else if (sa[k] === currentAttrs[k]) {
                  score++;
                }
              }
            });
            const curBase = currentSizeRaw.replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, "").trim();
            const sibSize = (sa["size"] || "").replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, "").trim();
            if (curBase && sibSize && curBase === sibSize) score += 2;
            return { ...s, score };
          });
          return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
        };
        const best = findFormatMatch();
        const isDisabled = !isActive && !best;
        return /* @__PURE__ */ React.createElement("button", { key: fmt, className: "attr-pill" + (isActive ? " active" : "") + (isDisabled ? " disabled" : ""), onClick: () => {
          if (!isActive && !isDisabled && best) onSkuClick(best.sku_id);
        } }, fmt);
      }))), showAttrs && attrSlugs.map((slug) => {
        const rawValues = [...attrMap[slug].values];
        const allValues = (slug === "size" && hasFormatPill ? (() => {
          const isStd = currentFormat === "Standard";
          const qualifier = !isStd && FORMAT_QUALIFIERS.find((q) => q.label === currentFormat);
          return rawValues.filter((val) => {
            if (isStd) return !FORMAT_QUALIFIERS.some((q) => q.pattern.test(val));
            return qualifier && qualifier.pattern.test(val);
          });
        })() : rawValues).sort(sizeSort);
        const currentVal = currentAttrs[slug];
        const compatibleValues = new Set(allValues.filter((val) => {
          const inProduct = effectiveSiblings.some((s) => {
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            if (val === "No Countertop" && slug === "countertop_finish") {
              if (sa[slug]) return false;
            } else if (sa[slug] !== val) return false;
            if (currentAttrs["color"] && sa["color"] && normColor(sa["color"]) !== normColor(currentAttrs["color"]) && !(slug === "finish" && _finishIsColor)) return false;
            if (currentAttrs["size"] && sa["size"] && normalizeSize(sa["size"]) !== normalizeSize(currentAttrs["size"])) return false;
            return attrSlugs.every((otherSlug) => {
              if (otherSlug === slug) return true;
              if (currentAttrs[otherSlug] === "No Countertop" && otherSlug === "countertop_finish") return !sa[otherSlug];
              return !currentAttrs[otherSlug] || !sa[otherSlug] || sa[otherSlug] === currentAttrs[otherSlug];
            });
          });
          return inProduct;
        }));
        if (allValues.length <= 1 && !currentVal) return null;
        const _scoreSibling = (sa) => {
          let score = 0;
          if (currentAttrs["color"] && sa["color"] && normColor(sa["color"]) === normColor(currentAttrs["color"])) score += 10;
          if (currentAttrs["size"] && sa["size"] && normalizeSize(sa["size"]) === normalizeSize(currentAttrs["size"])) score += 10;
          attrSlugs.forEach((k) => {
            if (k !== slug) {
              if (currentAttrs[k] === "No Countertop" && k === "countertop_finish") {
                if (!sa[k]) score++;
              } else if (sa[k] === currentAttrs[k]) {
                score++;
              }
            }
          });
          return score;
        };
        const findBest = (val) => {
          const matching = effectiveSiblings.filter((s) => {
            if (s.sku_id === sku.sku_id) return false;
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            if (val === "No Countertop" && slug === "countertop_finish") return !sa[slug];
            return sa[slug] === val;
          });
          if (matching.length === 0) return null;
          if (matching.length === 1) return matching[0];
          const scored = matching.map((s) => {
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            return { ...s, score: _scoreSibling(sa) };
          });
          return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
        };
        const findAny = (val) => {
          const matching = effectiveSiblings.filter((s) => {
            if (s.sku_id === sku.sku_id) return false;
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            if (val === "No Countertop" && slug === "countertop_finish") return !sa[slug];
            return sa[slug] === val;
          });
          if (matching.length === 0) return null;
          const scored = matching.map((s) => {
            const sa = (s.attributes || []).reduce((m, a) => {
              m[a.slug] = a.value;
              return m;
            }, {});
            return { ...s, score: _scoreSibling(sa) };
          });
          return scored.sort((a, b) => b.score - a.score || (a.sku_id < b.sku_id ? -1 : 1))[0];
        };
        const findCrossProduct = (val) => {
          if (!collectionSiblings.length) return null;
          let bestMatch = null;
          for (const cs of collectionSiblings) {
            if (!cs.sku_map) continue;
            for (const [key, sid] of Object.entries(cs.sku_map)) {
              const [szVal, fnVal] = key.split("|");
              const attrMatch = slug === "finish" ? fnVal === val : false;
              if (!attrMatch) continue;
              if (currentAttrs["size"] && normalizeSize(szVal) === normalizeSize(currentAttrs["size"])) return { sku_id: sid };
              if (!bestMatch) bestMatch = { sku_id: sid };
            }
          }
          return bestMatch;
        };
        const IMAGE_SWATCH_ATTRS = /* @__PURE__ */ new Set(["countertop_finish", "pattern"]);
        const useImageSwatches = IMAGE_SWATCH_ATTRS.has(slug) || slug === "finish" && attrMap["countertop_finish"];
        const getSwatchImage = (val) => {
          if (val === currentVal) {
            if (slug === "countertop_finish" && countertopImage) return countertopImage;
            return media && media[0] ? media[0].url : null;
          }
          const match = findBest(val);
          if (!match) return null;
          return getVariantImage(match, { preferCountertop: slug === "countertop_finish" });
        };
        const displayVal = (val) => {
          if (slug === "size" && hasFormatPill) {
            return formatSizeDim(val.replace(/\s*(Paver|Mosaic|TRIM|LINER|Deco)\s*/gi, "").trim() || val);
          }
          if (slug === "size") return formatSizeDim(val);
          return formatCarpetValue(val);
        };
        return /* @__PURE__ */ React.createElement("div", { key: slug, className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, slug === "finish" && attrMap["countertop_finish"] ? "Cabinet Color" : slug === "countertop_finish" ? "Countertop" : attrMap[slug].name, /* @__PURE__ */ React.createElement("span", null, displayVal(currentVal || ""))), useImageSwatches ? /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, allValues.map((val) => {
          const isActive = val === currentVal;
          const isDisabled = !compatibleValues.has(val);
          const img = getSwatchImage(val);
          const best = findBest(val);
          return /* @__PURE__ */ React.createElement("div", { key: val, className: "color-swatch-wrap" + (isDisabled ? " limited" : ""), onClick: () => {
            if (!isActive) {
              const target = best || findAny(val) || findCrossProduct(val);
              if (target) onSkuClick(target.sku_id);
            }
          } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (isActive ? " active" : "") + (isDisabled ? " limited" : "") }, img ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(img, 120), alt: displayVal(val), loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.6rem", color: "var(--stone-500)", textAlign: "center", padding: "0.25rem" } }, displayVal(val))), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, displayVal(val), isDisabled ? findCrossProduct(val) ? " (available in other colors)" : " (other options may change)" : ""));
        })) : /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, allValues.map((val) => {
          const isActive = val === currentVal;
          const isDisabled = !compatibleValues.has(val);
          const best = findBest(val);
          return /* @__PURE__ */ React.createElement("button", { key: val, className: "attr-pill" + (isActive ? " active" : "") + (isDisabled ? " limited" : ""), title: isDisabled ? findCrossProduct(val) ? "Available in other colors" : "Other options may change" : "", onClick: () => {
            if (!isActive) {
              const target = best || findAny(val) || findCrossProduct(val);
              if (target) onSkuClick(target.sku_id);
            }
          } }, displayVal(val));
        })));
      }));
    })(), /* @__PURE__ */ React.createElement(StockBadge, { status: sku.stock_status, vendorHasInventory: sku.vendor_has_inventory, qtyOnHand: sku.qty_on_hand, qtyOnHandSqft: sku.qty_on_hand_sqft, sellBy: sku.sell_by }), sku.stock_status === "out_of_stock" && sku.vendor_has_inventory !== false && /* @__PURE__ */ React.createElement("div", { className: "stock-alert-box" }, alertSuccess || alertSubscribed ? /* @__PURE__ */ React.createElement("div", { className: "stock-alert-success" }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "#166534", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M20 6L9 17l-5-5" })), "We'll notify you when this item is back in stock") : customer ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading }, alertLoading ? "Subscribing..." : "Notify Me When Available")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("div", { className: "stock-alert-form" }, /* @__PURE__ */ React.createElement("input", { type: "email", placeholder: "Enter your email", value: alertEmail, onChange: (e) => setAlertEmail(e.target.value) }), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading || !alertEmail }, alertLoading ? "Subscribing..." : "Notify Me")))), !isCarpetSku && sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "packaging-info" }, /* @__PURE__ */ React.createElement("div", { className: "pdp-pkg-cell" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-label" }, isSlabUnit ? "Slab Size" : "Coverage"), /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-value" }, sqftPerBox, " sqft", isSlabUnit ? "" : "/" + boxLabel)), !isSlabUnit && sku.pieces_per_box && /* @__PURE__ */ React.createElement("div", { className: "pdp-pkg-cell" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-label" }, "Pieces"), /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-value" }, sku.pieces_per_box, "/", boxLabel)), sku.weight_per_box_lbs && /* @__PURE__ */ React.createElement("div", { className: "pdp-pkg-cell" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-label" }, "Weight"), /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-value" }, parseFloat(sku.weight_per_box_lbs).toFixed(1), " lbs")), !isSlabUnit && sku.boxes_per_pallet && /* @__PURE__ */ React.createElement("div", { className: "pdp-pkg-cell" }, /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-label" }, "Pallet"), /* @__PURE__ */ React.createElement("span", { className: "pdp-pkg-cell-value" }, sku.boxes_per_pallet, " ", boxLabelPlural, sku.sqft_per_pallet ? " (" + parseFloat(sku.sqft_per_pallet).toLocaleString() + " sqft)" : ""))), isCarpetSku && (rollWidthFt > 0 || rollLengthFt > 0 || sku.sqft_per_pallet || sku.weight_per_pallet_lbs) && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info" }, /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-grid" }, rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Width"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, rollWidthFt, " ft")), rollLengthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Length"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, rollLengthFt, " ft")), sku.sqft_per_pallet && parseFloat(sku.sqft_per_pallet) > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Area"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, parseFloat(sku.sqft_per_pallet).toLocaleString(), " sqft")), sku.weight_per_pallet_lbs && parseFloat(sku.weight_per_pallet_lbs) > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Weight"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, parseFloat(sku.weight_per_pallet_lbs).toLocaleString(), " lbs")))), isCarpetSku && cutPrice > 0 && !isOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Carpet Calculator"), rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-width-header" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 20, height: 20 } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "9", x2: "21", y2: "9" })), rollWidthFt, "' Wide Roll"), /* @__PURE__ */ React.createElement("div", { className: "calc-mode-tabs" }, rollWidthFt > 0 && /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "linear" ? " active" : ""), onClick: () => setCarpetInputMode("linear") }, "Linear Feet"), /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "dimensions" ? " active" : ""), onClick: () => setCarpetInputMode("dimensions") }, "Room Size"), /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "sqft" ? " active" : ""), onClick: () => setCarpetInputMode("sqft") }, "Enter Sqft")), carpetInputMode === "linear" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Linear Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "e.g. 50",
        value: linearFeet,
        onChange: (e) => setLinearFeet(e.target.value)
      }
    ))) : carpetInputMode === "dimensions" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Room Width (ft)"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "0",
        value: roomWidth,
        onChange: (e) => setRoomWidth(e.target.value)
      }
    )), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", padding: "0 0.25rem 0.5rem", fontSize: "1.25rem", color: "var(--stone-400)" } }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Room Length (ft)"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "0",
        value: roomLength,
        onChange: (e) => setRoomLength(e.target.value)
      }
    ))) : /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "1",
        placeholder: "Enter sqft",
        value: sqftInput,
        onChange: (e) => setSqftInput(e.target.value)
      }
    ))), /* @__PURE__ */ React.createElement("label", { className: "carpet-overage-label" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: includeCarpetOverage, onChange: (e) => setIncludeCarpetOverage(e.target.checked) }), "Add 10% overage for seams & pattern matching"), carpetNeedsSeam && /* @__PURE__ */ React.createElement("div", { className: "carpet-seam-note" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "8", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "16", x2: "12.01", y2: "16" })), "Room width (", parseFloat(roomWidth).toFixed(0), "') exceeds roll width (", rollWidthFt, "') \u2014 a seam will be required"), carpetSqft > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, carpetInputMode === "linear" && rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Cut Size"), /* @__PURE__ */ React.createElement("span", null, rollWidthFt, " ft \xD7 ", parseFloat(linearFeet).toFixed(1), " ft = ", carpetRawSqft.toFixed(1), " sqft (", (carpetRawSqft / 9).toFixed(1), " sqyd)")), includeCarpetOverage && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "+ 10% Overage"), /* @__PURE__ */ React.createElement("span", null, carpetSqft.toFixed(1), " sqft")), !includeCarpetOverage && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Area"), /* @__PURE__ */ React.createElement("span", null, carpetSqft.toFixed(1), " sqft (", carpetSqyd.toFixed(1), " sqyd)")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Price Tier"), /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "0.375rem" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.125rem 0.5rem", borderRadius: "0.25rem", fontSize: "0.75rem", fontWeight: 600, background: carpetPriceTier === "roll" ? "var(--sage)" : "var(--stone-200)", color: carpetPriceTier === "roll" ? "white" : "var(--stone-700)" } }, carpetPriceTier === "roll" ? "Roll Price" : "Cut Price"), "$", carpetActivePrice.toFixed(2), "/sqyd")), carpetEstWeight > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Est. Weight"), /* @__PURE__ */ React.createElement("span", null, carpetEstWeight.toFixed(0), " lbs")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", carpetSubtotal.toFixed(2)))), carpetSqftToRoll > 0 && parseFloat(carpetRollSavings) > 0 && /* @__PURE__ */ React.createElement("div", { style: { background: "var(--sage-bg, #f0f7f4)", border: "1px solid var(--sage, #6b9080)", borderRadius: "0.375rem", padding: "0.625rem 0.75rem", fontSize: "0.8125rem", color: "var(--sage, #6b9080)", marginTop: "0.5rem" } }, "Add ", carpetSqftToRoll.toFixed(0), " more sqft for roll pricing \u2014 save $", carpetRollSavings), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-primary",
        style: { marginTop: "1.25rem" },
        onClick: handleAddToCart,
        disabled: carpetSqft <= 0 || isOutOfStock
      },
      isOutOfStock ? "Out of Stock" : "Add to Cart " + (carpetSqft > 0 ? "\u2014 $" + carpetSubtotal.toFixed(2) : "")
    )), !isCarpetSku && isSoldPerSqft && effectivePrice > 0 && !isOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Coverage Calculator"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "1",
        placeholder: "0",
        value: sqftInput,
        onChange: (e) => setSqftInput(e.target.value)
      }
    ))), /* @__PURE__ */ React.createElement("label", { className: "carpet-overage-label" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: includeOverage, onChange: (e) => setIncludeOverage(e.target.checked) }), "Add 10% overage for cuts & breakage"), sqftCalcAmount > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Coverage"), /* @__PURE__ */ React.createElement("span", null, sqftCalcAmount.toFixed(1), " sqft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Price"), /* @__PURE__ */ React.createElement("span", null, "$", effectivePrice.toFixed(2), "/sqft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", sqftCalcSubtotal.toFixed(2)))), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-primary",
        style: { marginTop: "1.25rem" },
        onClick: handleAddToCart,
        disabled: sqftCalcAmount <= 0 || isOutOfStock
      },
      isOutOfStock ? "Out of Stock" : "Add to Cart " + (sqftCalcAmount > 0 ? "\u2014 $" + sqftCalcSubtotal.toFixed(2) : "")
    )), !isCarpetSku && hasBoxCalc && effectivePrice > 0 && !isOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Coverage Calculator"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "1",
        placeholder: "0",
        value: sqftInput,
        onChange: (e) => handleSqftChange(e.target.value)
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, isSheetUnit ? "Sheets" : "Boxes"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "1",
        placeholder: "0",
        value: boxesInput,
        onChange: (e) => handleBoxesChange(e.target.value)
      }
    ))), /* @__PURE__ */ React.createElement("label", { className: "carpet-overage-label" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: includeOverage, onChange: (e) => setIncludeOverage(e.target.checked) }), "Add 10% overage for cuts & breakage"), numBoxes > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, isSheetUnit ? "Sheets" : "Boxes"), /* @__PURE__ */ React.createElement("span", null, numBoxes)), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Coverage"), /* @__PURE__ */ React.createElement("span", null, actualSqft.toFixed(1), " sqft")), numBoxes > 0 && sku.weight_per_box_lbs && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Est. Weight"), /* @__PURE__ */ React.createElement("span", null, (numBoxes * parseFloat(sku.weight_per_box_lbs)).toFixed(0), " lbs")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", subtotal.toFixed(2)))), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-primary",
        style: { marginTop: "1.25rem" },
        onClick: handleAddToCart,
        disabled: numBoxes <= 0 || isOutOfStock
      },
      isOutOfStock ? "Out of Stock" : "Add to Cart " + (numBoxes > 0 ? "\u2014 $" + subtotal.toFixed(2) : "")
    )), isSheetVinyl && effectivePrice > 0 && !isOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Roll Calculator"), /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-width-header" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "9", x2: "21", y2: "9" })), sheetRollWidthFt, "' Wide Roll"), /* @__PURE__ */ React.createElement("div", { className: "calc-mode-tabs" }, /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "linear" ? " active" : ""), onClick: () => setCarpetInputMode("linear") }, "Linear Feet"), /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "dimensions" ? " active" : ""), onClick: () => setCarpetInputMode("dimensions") }, "Room Size"), /* @__PURE__ */ React.createElement("button", { className: "calc-mode-tab" + (carpetInputMode === "sqft" ? " active" : ""), onClick: () => setCarpetInputMode("sqft") }, "Enter Sqft")), sheetMode === "linear" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Linear Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "e.g. 50",
        value: linearFeet,
        onChange: (e) => setLinearFeet(e.target.value)
      }
    ))) : sheetMode === "dimensions" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Room Width (ft)"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "0",
        value: roomWidth,
        onChange: (e) => setRoomWidth(e.target.value)
      }
    )), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", padding: "0 0.25rem 0.5rem", fontSize: "1.25rem", color: "var(--stone-400)" } }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Room Length (ft)"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "0.5",
        placeholder: "0",
        value: roomLength,
        onChange: (e) => setRoomLength(e.target.value)
      }
    ))) : /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "calc-input",
        type: "number",
        min: "0",
        step: "1",
        placeholder: "Enter sqft",
        value: sqftInput,
        onChange: (e) => setSqftInput(e.target.value)
      }
    ))), /* @__PURE__ */ React.createElement("label", { className: "carpet-overage-label" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: includeCarpetOverage, onChange: (e) => setIncludeCarpetOverage(e.target.checked) }), "Add 10% overage for seams & waste"), sheetNeedsSeam && /* @__PURE__ */ React.createElement("div", { className: "carpet-seam-note" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "8", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "16", x2: "12.01", y2: "16" })), "Room width (", parseFloat(roomWidth).toFixed(0), "') exceeds roll width (", sheetRollWidthFt, "') \u2014 a seam will be required"), sheetSqft > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, sheetMode === "linear" && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Cut Size"), /* @__PURE__ */ React.createElement("span", null, sheetRollWidthFt, " ft \xD7 ", parseFloat(linearFeet).toFixed(1), " ft = ", sheetRawSqft.toFixed(1), " sqft")), includeCarpetOverage && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "+ 10% Overage"), /* @__PURE__ */ React.createElement("span", null, sheetSqft.toFixed(1), " sqft")), !includeCarpetOverage && sheetMode !== "linear" && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Area"), /* @__PURE__ */ React.createElement("span", null, sheetSqft.toFixed(1), " sqft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Price"), /* @__PURE__ */ React.createElement("span", null, "$", effectivePrice.toFixed(2), "/sqft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", sheetSubtotal.toFixed(2)))), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-primary",
        style: { marginTop: "1.25rem" },
        onClick: handleAddToCart,
        disabled: sheetSqft <= 0 || isOutOfStock
      },
      isOutOfStock ? "Out of Stock" : "Add to Cart " + (sheetSqft > 0 ? "\u2014 $" + sheetSubtotal.toFixed(2) : "")
    )), isPerUnit && (slabMissingSize || effectivePrice <= 0) && /* @__PURE__ */ React.createElement("div", { className: "unit-add-to-cart" }, /* @__PURE__ */ React.createElement("div", { style: { background: "var(--cream-warm)", border: "0.5px solid rgba(21,18,15,0.07)", borderRadius: 4, padding: "1.5rem", textAlign: "center" } }, /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 0.375rem", fontFamily: "var(--font-heading)", fontSize: "1.125rem", fontWeight: 300, color: "var(--stone-900)" } }, "Slab \u2014 Please Inquire"), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "0.8125rem", color: "var(--stone-500)", lineHeight: 1.5 } }, "Contact us to confirm slab dimensions and availability."), /* @__PURE__ */ React.createElement("a", { href: "tel:7149990009", className: "pdp-btn pdp-btn-ghost", style: { marginTop: "1rem", textDecoration: "none" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("path", { d: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" })), "Call (714) 999-0009"))), isPerUnit && !slabMissingSize && effectivePrice > 0 && !isOutOfStock && /* @__PURE__ */ React.createElement("div", { className: "unit-add-to-cart" }, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-row" }, /* @__PURE__ */ React.createElement("span", { className: "unit-qty-label" }, "Quantity"), /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setUnitQty((q) => Math.max(1, q - 1)) }, "\u2212"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "number",
        min: "1",
        step: "1",
        value: unitQty,
        onChange: (e) => setUnitQty(Math.max(1, parseInt(e.target.value) || 1))
      }
    ), /* @__PURE__ */ React.createElement("button", { onClick: () => setUnitQty((q) => q + 1) }, "+"))), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-primary",
        onClick: handleAddToCart,
        disabled: unitQty <= 0 || isOutOfStock
      },
      isOutOfStock ? "Out of Stock" : effectivePrice > 0 ? "Add to Cart \u2014 $" + unitSubtotal.toFixed(2) : "Add to Cart"
    )), !isCarpetSku && !isPerUnit && !isSoldPerSqft && (effectivePrice <= 0 || sqftPerBox <= 0 && !isSheetVinyl) && /* @__PURE__ */ React.createElement("div", { style: { background: "var(--cream-warm)", border: "0.5px solid rgba(21,18,15,0.07)", borderRadius: 4, padding: "1.5rem", textAlign: "center" } }, /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 0.375rem", fontFamily: "var(--font-heading)", fontSize: "1.125rem", fontWeight: 300, color: "var(--stone-900)" } }, "Call for Price & Stock"), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "0.8125rem", color: "var(--stone-500)", lineHeight: 1.5 } }, "Contact us for current pricing, stock availability, and lead times."), /* @__PURE__ */ React.createElement("a", { href: "tel:7149990009", className: "pdp-btn pdp-btn-ghost", style: { marginTop: "1rem", textDecoration: "none" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("path", { d: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" })), "Call (714) 999-0009")), accessorySiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "accessories-section-sf" }, /* @__PURE__ */ React.createElement("h3", null, "Matching Accessories"), /* @__PURE__ */ React.createElement("div", { className: "accessories-subtitle-sf" }, /^bath/i.test(sku.category_slug || "") || /vanitie|mirror|cabinet/i.test(sku.category_name || "") ? "Complete your bathroom with matching pieces" : "Complete your installation with coordinating trim and transitions"), accessorySiblings.map((acc) => {
      const accPrice = parseFloat(acc.sale_price || acc.retail_price) || 0;
      const accQty = accessoryQtys[acc.sku_id] || 1;
      const accLabel = acc.accessory_label || formatVariantName(acc.variant_name) || "Accessory";
      return /* @__PURE__ */ React.createElement("div", { key: acc.sku_id, className: "accessory-card-sf" }, acc.primary_image && /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-image", style: { cursor: "pointer" }, onClick: () => onSkuClick(acc.sku_id, acc.accessory_label || acc.variant_name) }, /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(acc.primary_image, 80), alt: accLabel, width: "48", height: "48", loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-header" }, /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-name", style: { cursor: "pointer" }, onClick: () => onSkuClick(acc.sku_id, acc.accessory_label || acc.variant_name) }, accLabel), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-price" }, "$", accPrice.toFixed(2), " ", acc.sell_by === "box" ? "/sqft" : "/ea")), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-actions" }, /* @__PURE__ */ React.createElement("div", { className: "acc-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: Math.max(1, (prev[acc.sku_id] || 1) - 1) })) }, "\u2212"), /* @__PURE__ */ React.createElement("span", null, accQty), /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: (prev[acc.sku_id] || 1) + 1 })) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "acc-add-btn", onClick: () => {
        addToCart({
          product_id: sku.product_id,
          sku_id: acc.sku_id,
          sqft_needed: 0,
          num_boxes: accQty,
          include_overage: false,
          unit_price: accPrice,
          subtotal: (accQty * accPrice).toFixed(2),
          sell_by: acc.sell_by || "unit"
        });
      } }, "Add $", (accQty * accPrice).toFixed(2))));
    })), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "pdp-btn pdp-btn-ghost roomvo-visualize-btn",
        ref: (el) => {
          try {
            if (el && window.roomvo) window.roomvo.enableButtonForVisualization(el);
          } catch (e) {
          }
        },
        "data-sku": sku.vendor_sku || sku.internal_sku,
        style: { visibility: "hidden" }
      },
      /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 18, height: 18 } }, /* @__PURE__ */ React.createElement("path", { d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 22 9 12 15 12 15 22" })),
      "Visualize in Your Room"
    ), /* @__PURE__ */ React.createElement("button", { className: "pdp-btn pdp-btn-ghost", onClick: handleRequestSample }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M3 9h18" })), "Request Free Sample"), /* @__PURE__ */ React.createElement("div", { className: "install-cta" }, /* @__PURE__ */ React.createElement("div", { className: "install-cta-text" }, /* @__PURE__ */ React.createElement("div", { className: "install-cta-title" }, "Need professional installation?"), /* @__PURE__ */ React.createElement("div", { className: "install-cta-sub" }, "Free estimates \xB7 Licensed & insured installers")), /* @__PURE__ */ React.createElement("button", { className: "pdp-btn pdp-btn-primary", onClick: () => onRequestInstall(sku) }, "Get Quote")))), groupedProducts.length > 0 && (() => {
      const byCategory = {};
      groupedProducts.forEach((gp) => {
        const cat = gp.category_name || "Related";
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(gp);
      });
      return /* @__PURE__ */ React.createElement("div", { className: "siblings-section", ref: sectionRefs.companions }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-eyebrow" }, "02 \u2014 Complete the Look"), /* @__PURE__ */ React.createElement("h2", null, "Companion Products")), Object.entries(byCategory).map(([catName, items]) => /* @__PURE__ */ React.createElement("div", { key: catName, style: { marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta", style: { marginBottom: "0.75rem", fontSize: "0.6875rem" } }, catName), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, items.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 400), alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, s.product_name), skuListPrice(s) && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "from $", displayPrice(s, skuListPrice(s)).toFixed(2), priceSuffix(s))))))));
    })(), !isAdexProduct && mainSiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section", ref: sectionRefs.variants }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-eyebrow" }, "03 \u2014 Variants"), /* @__PURE__ */ React.createElement("h2", null, "Other Sizes & Finishes"), /* @__PURE__ */ React.createElement("div", { className: "siblings-section-sub" }, "Same species, same finish \u2014 different plank dimensions and price points.")), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, mainSiblings.map((s) => {
      const isCurrent = s.sku_id === skuId;
      return /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card" + (isCurrent ? " is-current" : ""), onClick: () => !isCurrent && onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 400), alt: formatVariantName(s.variant_name), loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, formatCarpetValue(s.variant_name) || "Variant"), s.attributes && s.attributes.length > 0 && (() => {
        const SKIP = /* @__PURE__ */ new Set(["price_list", "material_class", "style_code", "subcategory", "upc", "color", "color_code", "collection", "material", "companion_skus", "brand", "application", "roll_width", "roll_length", "weight_per_sqyd"]);
        const useful = s.attributes.filter((a) => !SKIP.has(a.slug));
        const currentVals = (sku.attributes || []).reduce((m, a) => {
          m[a.slug] = a.value;
          return m;
        }, {});
        const differing = useful.filter((a) => currentVals[a.slug] !== a.value);
        if (differing.length === 0) return null;
        return /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta" }, differing.map((a) => formatCarpetValue(a.value)).join(" \xB7 "));
      })(), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-footer" }, skuListPrice(s) && /* @__PURE__ */ React.createElement("span", { className: "sibling-card-price" }, "$", displayPrice(s, skuListPrice(s)).toFixed(2), priceSuffix(s)), /* @__PURE__ */ React.createElement("span", { className: "sibling-card-cta" }, isCurrent ? "Current" : "View \u2192")));
    }))), (() => {
      if (isAdexProduct) return null;
      if (collectionSiblings.length === 0) return null;
      return /* @__PURE__ */ React.createElement("div", { className: "siblings-section", ref: sectionRefs.collection }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-eyebrow" }, "04 \u2014 Collection"), /* @__PURE__ */ React.createElement("h2", null, "More from ", /* @__PURE__ */ React.createElement("em", null, sku.collection))), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, collectionSiblings.map((s) => {
        const isCurrent = s.sku_id === skuId;
        return /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card" + (isCurrent ? " is-current" : ""), onClick: () => !isCurrent && onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 400), alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(s)), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-footer" }, skuListPrice(s) && /* @__PURE__ */ React.createElement("span", { className: "sibling-card-price" }, "$", displayPrice(s, skuListPrice(s)).toFixed(2), priceSuffix(s)), /* @__PURE__ */ React.createElement("span", { className: "sibling-card-cta" }, isCurrent ? "Current" : "View \u2192")));
      })));
    })(), recentlyViewed && recentlyViewed.filter((r) => r.sku_id !== skuId).length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section", ref: sectionRefs.recent }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header-row" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-eyebrow" }, "05 \u2014 Recently Viewed"), /* @__PURE__ */ React.createElement("h2", null, "Recently Viewed")), /* @__PURE__ */ React.createElement("span", { className: "siblings-section-aside" }, "Saved on this device"))), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.filter((r) => r.sku_id !== skuId).slice(0, 8).map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(s.primary_image, 400), alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(s)), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-footer" }, skuListPrice(s) && /* @__PURE__ */ React.createElement("span", { className: "sibling-card-price" }, "$", displayPrice(s, skuListPrice(s)).toFixed(2), priceSuffix(s)), /* @__PURE__ */ React.createElement("span", { className: "sibling-card-cta" }, "View \u2192")))))), /* @__PURE__ */ React.createElement("div", { className: "reviews-section", ref: sectionRefs.reviews }, /* @__PURE__ */ React.createElement("div", { className: "reviews-grid" }, /* @__PURE__ */ React.createElement("div", { className: "reviews-sidebar", ref: reviewsSidebarRef }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-header" }, /* @__PURE__ */ React.createElement("div", { className: "siblings-section-eyebrow" }, "06 \u2014 Reviews"), /* @__PURE__ */ React.createElement("h2", null, "Customer Reviews")), reviewCount > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "reviews-sidebar-rating" }, avgRating.toFixed(1), /* @__PURE__ */ React.createElement("span", null, "/5")), /* @__PURE__ */ React.createElement("div", { className: "reviews-sidebar-stars" }, /* @__PURE__ */ React.createElement(StarDisplay, { rating: avgRating, size: 18 })), /* @__PURE__ */ React.createElement("div", { className: "reviews-sidebar-count" }, reviewCount, " verified review", reviewCount !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("div", { className: "reviews-dist" }, [5, 4, 3, 2, 1].map((star) => {
      const count = reviews.filter((r) => Math.round(r.rating) === star).length;
      const pct = reviewCount > 0 ? Math.round(count / reviewCount * 100) : 0;
      return /* @__PURE__ */ React.createElement("div", { key: star, className: "reviews-dist-row" }, /* @__PURE__ */ React.createElement("span", { className: "reviews-dist-label" }, star, "\u2605"), /* @__PURE__ */ React.createElement("div", { className: "reviews-dist-bar" }, /* @__PURE__ */ React.createElement("div", { className: "reviews-dist-fill", style: { width: pct + "%" } })), /* @__PURE__ */ React.createElement("span", { className: "reviews-dist-pct" }, pct, "%"));
    }))) : /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.875rem", fontStyle: "italic" } }, "No reviews yet. Be the first to share your experience.")), /* @__PURE__ */ React.createElement("div", { className: "reviews-main", ref: reviewsMainRef }, customer ? reviewSubmitted ? /* @__PURE__ */ React.createElement("div", { className: "review-submitted" }, /* @__PURE__ */ React.createElement("div", { className: "review-submitted-label" }, "\u2713 Submitted for review"), /* @__PURE__ */ React.createElement("div", { className: "review-submitted-msg" }, "Thanks \u2014 we\u2019ll publish it within 24 hours.")) : /* @__PURE__ */ React.createElement("div", { className: "review-form" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-form-title" }, "Write a review"), /* @__PURE__ */ React.createElement("div", { className: "review-form-sub" }, "Posting as ", /* @__PURE__ */ React.createElement("strong", null, tradeCustomer ? "Roma Trade Member" : "Verified Buyer"))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-form-label" }, "Rating"), /* @__PURE__ */ React.createElement("div", { className: "star-picker" }, [1, 2, 3, 4, 5].map((i) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: i,
        className: (i <= (reviewHover || reviewRating) ? "active" : "") + (i <= reviewHover ? " hover" : ""),
        onMouseEnter: () => setReviewHover(i),
        onMouseLeave: () => setReviewHover(0),
        onClick: () => setReviewRating(i)
      },
      /* @__PURE__ */ React.createElement("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: i <= (reviewHover || reviewRating) ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.4" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01z" }))
    )))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-form-label" }, "Title"), /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "One-line summary", value: reviewTitle, onChange: (e) => setReviewTitle(e.target.value), maxLength: 200 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-form-label" }, "Your review"), /* @__PURE__ */ React.createElement("textarea", { placeholder: "What worked, what didn't, what you'd tell the next buyer.", value: reviewBody, onChange: (e) => setReviewBody(e.target.value) })), /* @__PURE__ */ React.createElement("div", { className: "review-form-actions" }, /* @__PURE__ */ React.createElement("button", { className: "pdp-btn pdp-btn-primary", onClick: handleReviewSubmit, disabled: reviewSubmitting || reviewRating < 1 }, reviewSubmitting ? "Submitting..." : "Submit Review"))) : /* @__PURE__ */ React.createElement("div", { className: "review-signin" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-signin-text" }, "Sign in to write a review."), /* @__PURE__ */ React.createElement("div", { className: "review-signin-sub" }, "Verified buyers only \u2014 no anonymous comments, no incentives.")), /* @__PURE__ */ React.createElement("button", { className: "pdp-btn pdp-btn-primary", onClick: (e) => {
      e.preventDefault();
      onShowAuth();
    } }, "Sign in")), reviews.map((r) => /* @__PURE__ */ React.createElement("div", { key: r.id, className: "review-card" }, /* @__PURE__ */ React.createElement("div", { className: "review-card-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "review-card-author" }, r.first_name), /* @__PURE__ */ React.createElement("div", { className: "review-card-meta" }, new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), " \xB7 ", /* @__PURE__ */ React.createElement("span", { className: "verified" }, "\u2713 Verified"))), /* @__PURE__ */ React.createElement(StarDisplay, { rating: r.rating, size: 14 })), r.title && /* @__PURE__ */ React.createElement("div", { className: "review-card-title" }, r.title), r.body && /* @__PURE__ */ React.createElement("div", { className: "review-card-body" }, r.body))))))));
  }
  function CartPage({ cart, goBrowse, removeFromCart, updateCartItem, goCheckout, deliveryMethod, setDeliveryMethod, liftgateEnabled, setLiftgateEnabled, sessionId, appliedPromoCode, setAppliedPromoCode, goHome }) {
    const [shippingZip, setShippingZip] = useState("");
    const [shippingEstimate, setShippingEstimate] = useState(null);
    const [shippingLoading, setShippingLoading] = useState(false);
    const [shippingError, setShippingError] = useState("");
    const [selectedShippingOption, setSelectedShippingOption] = useState(null);
    const [promoCode, setPromoCode] = useState(appliedPromoCode || "");
    const [promoResult, setPromoResult] = useState(null);
    const [promoLoading, setPromoLoading] = useState(false);
    const [promoError, setPromoError] = useState("");
    const promoSubtotalRef = useRef(null);
    const productItems = cart.filter((i) => !i.is_sample);
    const sampleItems = cart.filter((i) => i.is_sample);
    const hasOutOfStock = productItems.some((i) => i.stock_status === "out_of_stock" && i.vendor_has_inventory);
    const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
    const sampleShipping = sampleItems.length > 0 ? 12 : 0;
    const productShipping = deliveryMethod === "pickup" ? 0 : selectedShippingOption ? selectedShippingOption.amount : 0;
    const promoDiscount = promoResult ? promoResult.discount_amount : 0;
    const cartTotal = Math.max(0, productSubtotal + productShipping + sampleShipping - promoDiscount);
    useEffect(() => {
      if (promoResult && promoSubtotalRef.current !== null && promoSubtotalRef.current !== productSubtotal) {
        setPromoResult(null);
        setPromoError("");
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
      setPromoError("");
      fetch(API + "/api/promo-codes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, session_id: sessionId })
      }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        if (data.valid) {
          setPromoResult(data);
          setPromoError("");
          setAppliedPromoCode(data.code);
          setPromoCode(data.code);
        } else {
          setPromoResult(null);
          setPromoError(data.error || "Invalid promo code");
          setAppliedPromoCode(null);
        }
        setPromoLoading(false);
      }).catch(() => {
        setPromoError("Unable to validate promo code");
        setPromoLoading(false);
      });
    };
    const removePromo = () => {
      setPromoResult(null);
      setPromoCode("");
      setPromoError("");
      setAppliedPromoCode(null);
    };
    const boxItems = productItems.filter((i) => i.sell_by !== "unit");
    const unitItems = productItems.filter((i) => i.sell_by === "unit");
    const totalBoxes = boxItems.reduce((sum, i) => sum + (parseInt(i.num_boxes) || 0), 0);
    const totalUnits = unitItems.reduce((sum, i) => sum + (parseInt(i.num_boxes) || 0), 0);
    const hasPickupOnly = productItems.some((i) => i.pickup_only);
    useEffect(() => {
      if (hasPickupOnly) setDeliveryMethod("pickup");
    }, [hasPickupOnly]);
    const fetchShippingEstimate = () => {
      const zip = shippingZip.trim();
      if (!zip || zip.length < 5) return;
      setShippingLoading(true);
      setShippingError("");
      setSelectedShippingOption(null);
      fetch(API + "/api/shipping/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, destination: { zip }, residential: true, liftgate: liftgateEnabled })
      }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        if (data.error) {
          setShippingError(data.error);
          setShippingEstimate(null);
          setSelectedShippingOption(null);
        } else {
          setShippingEstimate(data);
          setShippingError("");
          const opts = data.options || [];
          const cheapest = opts.find((o) => o.is_cheapest) || opts[0];
          setSelectedShippingOption(cheapest || null);
        }
        setShippingLoading(false);
      }).catch(() => {
        setShippingError("Unable to estimate shipping");
        setShippingLoading(false);
      });
    };
    const handleQtyChange = (item, delta) => {
      const newBoxes = Math.max(1, (parseInt(item.num_boxes) || 0) + delta);
      const unitPrice = parseFloat(item.unit_price) || 0;
      if (item.sell_by === "unit") {
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
    if (cart.length === 0) {
      return /* @__PURE__ */ React.createElement("div", { className: "ct-wrap" }, /* @__PURE__ */ React.createElement("section", { className: "ct-header" }, /* @__PURE__ */ React.createElement("nav", { className: "ct-breadcrumb" }, /* @__PURE__ */ React.createElement("a", { onClick: goHome }, "Home"), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-sep" }), /* @__PURE__ */ React.createElement("a", { onClick: goBrowse }, "Shop"), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-sep" }), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-current" }, "Your Cart")), /* @__PURE__ */ React.createElement("div", { className: "ct-hero-grid" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "ct-eyebrow", style: { color: "var(--gold)" } }, "0 items \xB7 cart empty"), /* @__PURE__ */ React.createElement("h1", { className: "ct-title" }, "Nothing in the cart, ", /* @__PURE__ */ React.createElement("em", null, "yet"), ".")), /* @__PURE__ */ React.createElement("div", { className: "ct-hero-right" }, /* @__PURE__ */ React.createElement("p", { className: "ct-hero-desc" }, "Start a sample box, pick up where you left off, or browse the showroom by material. Anything you add will sit here, saved across devices, until you're ready to check out."), /* @__PURE__ */ React.createElement("div", { className: "ct-hero-actions" }, /* @__PURE__ */ React.createElement("button", { className: "ct-btn-primary", onClick: goBrowse }, "Browse the shop"))))));
    }
    const itemCount = productItems.length + sampleItems.length;
    const materialLabel = productItems.length === 1 ? "1 material" : productItems.length + " materials";
    const sampleLabel = sampleItems.length > 0 ? sampleItems.length === 1 ? " \xB7 1 sample" : " \xB7 " + sampleItems.length + " samples" : "";
    return /* @__PURE__ */ React.createElement("div", { className: "ct-wrap" }, /* @__PURE__ */ React.createElement("section", { className: "ct-header" }, /* @__PURE__ */ React.createElement("div", { className: "ct-header-top" }, /* @__PURE__ */ React.createElement("nav", { className: "ct-breadcrumb" }, /* @__PURE__ */ React.createElement("a", { onClick: goHome }, "Home"), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-sep" }), /* @__PURE__ */ React.createElement("a", { onClick: goBrowse }, "Shop"), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-sep" }), /* @__PURE__ */ React.createElement("span", { className: "ct-breadcrumb-current" }, "Your Cart"))), /* @__PURE__ */ React.createElement("div", { className: "ct-hero-grid" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "ct-eyebrow", style: { color: "var(--gold)" } }, materialLabel, sampleLabel, " \xB7 in your cart"), /* @__PURE__ */ React.createElement("h1", { className: "ct-title" }, "Your ", /* @__PURE__ */ React.createElement("em", null, "cart"), ".")), /* @__PURE__ */ React.createElement("div", { className: "ct-hero-right" }, totalSqft > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-stats-strip" }, /* @__PURE__ */ React.createElement("div", { className: "ct-stat" }, /* @__PURE__ */ React.createElement("div", { className: "ct-stat-value" }, Math.round(totalSqft), " sf"), /* @__PURE__ */ React.createElement("div", { className: "ct-stat-label" }, "Materials")), /* @__PURE__ */ React.createElement("div", { className: "ct-stat" }, /* @__PURE__ */ React.createElement("div", { className: "ct-stat-value" }, "$", productSubtotal.toLocaleString(void 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })), /* @__PURE__ */ React.createElement("div", { className: "ct-stat-label" }, "Subtotal")), /* @__PURE__ */ React.createElement("div", { className: "ct-stat" }, /* @__PURE__ */ React.createElement("div", { className: "ct-stat-value" }, itemCount), /* @__PURE__ */ React.createElement("div", { className: "ct-stat-label" }, itemCount === 1 ? "Item" : "Items")))))), /* @__PURE__ */ React.createElement("div", { className: "ct-grid" }, /* @__PURE__ */ React.createElement("div", { className: "ct-items" }, /* @__PURE__ */ React.createElement("div", { className: "ct-items-header" }, /* @__PURE__ */ React.createElement("h2", { className: "ct-items-title" }, "Materials")), cart.map((item, idx) => {
      const isLast = idx === cart.length - 1;
      const sqft = parseFloat(item.sqft_needed || 0);
      const boxes = parseInt(item.num_boxes) || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      const subtotal = parseFloat(item.subtotal || 0);
      const canStepper = !item.is_sample && item.sell_by !== "sqft" && !item.price_tier;
      const priceSuf = item.sell_by === "unit" ? "/ea" : item.sell_by === "roll" ? "/sqyd" : "/sqft";
      return /* @__PURE__ */ React.createElement("div", { key: item.id, className: "ct-line" + (isLast ? " ct-line-last" : "") }, /* @__PURE__ */ React.createElement("div", { className: "ct-line-thumb" }, item.primary_image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(item.primary_image, 200), alt: "", onLoad: handleProductImgLoad, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { className: "ct-line-thumb-placeholder" }), item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "ct-line-sample-badge" }, "Sample")), /* @__PURE__ */ React.createElement("div", { className: "ct-line-info" }, /* @__PURE__ */ React.createElement("div", { className: "ct-line-cat" }, item.category_name || ""), /* @__PURE__ */ React.createElement("h3", { className: "ct-line-name" }, fullProductName(item) || "Product"), item.variant_name && /* @__PURE__ */ React.createElement("div", { className: "ct-line-variant" }, item.variant_name), item.stock_status && item.stock_status !== "unknown" && /* @__PURE__ */ React.createElement("div", { className: "ct-line-stock" + (item.stock_status === "in_stock" ? " in-stock" : item.stock_status === "low_stock" ? " low-stock" : " out-stock") }, item.stock_status === "in_stock" ? "In stock" : item.stock_status === "low_stock" ? "Low stock" : "Out of stock"), item.stock_status === "out_of_stock" && item.vendor_has_inventory && !item.is_sample && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: "0.375rem", padding: "0.5rem 0.75rem", fontSize: "0.8125rem", color: "#991b1b", marginTop: "0.375rem" } }, "This item is out of stock \u2014 remove it to proceed"), item.pickup_only && /* @__PURE__ */ React.createElement("div", { className: "ct-line-pickup-badge" }, "Pickup only"), /* @__PURE__ */ React.createElement("div", { className: "ct-line-actions" }, /* @__PURE__ */ React.createElement("a", { className: "ct-line-action-remove", onClick: () => removeFromCart(item.id) }, "Remove"))), /* @__PURE__ */ React.createElement("div", { className: "ct-line-right" }, canStepper && /* @__PURE__ */ React.createElement("div", { className: "ct-qty-wrap" }, /* @__PURE__ */ React.createElement("div", { className: "ct-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { className: "ct-qty-btn", onClick: () => handleQtyChange(item, -1), "aria-label": "Decrease quantity" }, "\u2212"), /* @__PURE__ */ React.createElement("span", { className: "ct-qty-value" }, boxes, " ", item.sell_by === "unit" ? boxes === 1 ? "unit" : "units" : boxes === 1 ? "box" : "boxes"), /* @__PURE__ */ React.createElement("button", { className: "ct-qty-btn", onClick: () => handleQtyChange(item, 1), "aria-label": "Increase quantity" }, "+")), item.sell_by !== "unit" && sqft > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-qty-coverage" }, sqft.toFixed(1), " sf coverage")), !canStepper && !item.is_sample && /* @__PURE__ */ React.createElement("div", { className: "ct-qty-wrap" }, /* @__PURE__ */ React.createElement("div", { className: "ct-qty-static" }, item.sell_by === "sqft" || item.price_tier ? `${sqft.toFixed(0)} sqft` : `${boxes} ${item.sell_by === "unit" ? "unit" : "box"}${boxes !== 1 ? item.sell_by === "unit" ? "s" : "es" : ""}`)), !item.is_sample && /* @__PURE__ */ React.createElement("div", { className: "ct-line-unit-price" }, /* @__PURE__ */ React.createElement("span", null, "Unit price"), /* @__PURE__ */ React.createElement("span", { className: "ct-line-unit-price-value" }, "$", unitPrice.toFixed(2), /* @__PURE__ */ React.createElement("span", { className: "ct-line-unit-price-suffix" }, priceSuf))), item.price_tier && /* @__PURE__ */ React.createElement("div", { className: "ct-line-price-tier" }, item.price_tier === "roll" ? "Roll price" : "Cut price"), /* @__PURE__ */ React.createElement("div", { className: "ct-line-subtotal" }, /* @__PURE__ */ React.createElement("span", { className: "ct-line-subtotal-label" }, "Subtotal"), /* @__PURE__ */ React.createElement("span", { className: "ct-line-subtotal-value" }, item.is_sample ? "Free" : "$" + subtotal.toFixed(2)))));
    }), /* @__PURE__ */ React.createElement("div", { className: "ct-promo-row" }, /* @__PURE__ */ React.createElement("div", { className: "ct-promo-input-wrap" }, promoResult ? /* @__PURE__ */ React.createElement("div", { className: "ct-promo-applied" }, /* @__PURE__ */ React.createElement("span", { className: "ct-promo-code-pill" }, promoResult.code), /* @__PURE__ */ React.createElement("span", { className: "ct-promo-discount" }, "-$", promoDiscount.toFixed(2)), /* @__PURE__ */ React.createElement("a", { className: "ct-promo-remove", onClick: (e) => {
      e.preventDefault();
      removePromo();
    } }, "Remove")) : /* @__PURE__ */ React.createElement("div", { className: "ct-promo-form" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "text",
        value: promoCode,
        onChange: (e) => {
          setPromoCode(e.target.value.toUpperCase());
          setPromoError("");
        },
        placeholder: "Promo code or trade ID",
        onKeyDown: (e) => e.key === "Enter" && applyPromoCode(),
        className: "ct-promo-input"
      }
    ), /* @__PURE__ */ React.createElement("button", { onClick: () => applyPromoCode(), disabled: promoLoading || !promoCode.trim(), className: "ct-promo-apply" }, promoLoading ? "..." : "Apply")), promoError && /* @__PURE__ */ React.createElement("div", { className: "ct-promo-error" }, promoError), promoResult && promoResult.description && /* @__PURE__ */ React.createElement("div", { className: "ct-promo-desc" }, promoResult.description)), /* @__PURE__ */ React.createElement("a", { className: "ct-keep-browsing", onClick: (e) => {
      e.preventDefault();
      goBrowse();
    } }, "\u2190 Keep browsing"))), /* @__PURE__ */ React.createElement("aside", { className: "ct-summary" }, /* @__PURE__ */ React.createElement("div", { className: "ct-summary-inner" }, /* @__PURE__ */ React.createElement("div", { className: "ct-summary-eyebrow" }, "Order summary"), /* @__PURE__ */ React.createElement("div", { className: "ct-summary-lines" }, productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line" }, /* @__PURE__ */ React.createElement("span", null, "Materials subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", productSubtotal.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line" }, /* @__PURE__ */ React.createElement("span", null, "Samples (", sampleItems.length, ")"), /* @__PURE__ */ React.createElement("span", null, "Free")), /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line" }, /* @__PURE__ */ React.createElement("span", null, "Sample shipping"), /* @__PURE__ */ React.createElement("span", null, "$12.00"))), promoResult && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line ct-summary-line-accent" }, /* @__PURE__ */ React.createElement("span", null, "Promo \xB7 ", promoResult.code), /* @__PURE__ */ React.createElement("span", null, "-$", promoDiscount.toFixed(2)))), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-delivery" }, /* @__PURE__ */ React.createElement("div", { className: "ct-summary-delivery-label" }, "Delivery"), hasPickupOnly && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-pickup-notice" }, "Cart contains pickup-only items."), /* @__PURE__ */ React.createElement("label", { className: "ct-delivery-option" + (deliveryMethod === "pickup" ? " active" : "") }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "radio",
        name: "ctDelivery",
        value: "pickup",
        checked: deliveryMethod === "pickup",
        onChange: () => {
          setDeliveryMethod("pickup");
          setShippingEstimate(null);
          setSelectedShippingOption(null);
        }
      }
    ), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "ct-delivery-option-title" }, "Showroom pickup"), /* @__PURE__ */ React.createElement("div", { className: "ct-delivery-option-sub" }, "Free \xB7 Anaheim"))), /* @__PURE__ */ React.createElement("label", { className: "ct-delivery-option" + (deliveryMethod === "shipping" ? " active" : "") + (hasPickupOnly ? " disabled" : "") }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "radio",
        name: "ctDelivery",
        value: "shipping",
        checked: deliveryMethod === "shipping",
        onChange: () => setDeliveryMethod("shipping"),
        disabled: hasPickupOnly
      }
    ), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "ct-delivery-option-title" }, "Ship to address"), /* @__PURE__ */ React.createElement("div", { className: "ct-delivery-option-sub" }, "Enter ZIP for rate"))), deliveryMethod === "shipping" && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-shipping" }, /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-zip-row" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "text",
        placeholder: "ZIP Code",
        value: shippingZip,
        onChange: (e) => setShippingZip(e.target.value.replace(/\D/g, "").slice(0, 5)),
        onKeyDown: (e) => e.key === "Enter" && fetchShippingEstimate(),
        maxLength: 5,
        className: "ct-shipping-zip-input"
      }
    ), /* @__PURE__ */ React.createElement("button", { onClick: fetchShippingEstimate, disabled: shippingLoading || shippingZip.length < 5, className: "ct-shipping-zip-btn" }, shippingLoading ? "..." : "Get rate")), shippingError && /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-error" }, shippingError), shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-options" }, shippingEstimate.options.map((opt) => /* @__PURE__ */ React.createElement(
      "label",
      {
        key: opt.id,
        className: "ct-shipping-opt" + (selectedShippingOption && selectedShippingOption.id === opt.id ? " active" : ""),
        onClick: () => setSelectedShippingOption(opt)
      },
      /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "radio",
          name: "ctShipping",
          checked: selectedShippingOption && selectedShippingOption.id === opt.id,
          onChange: () => setSelectedShippingOption(opt)
        }
      ),
      /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-opt-info" }, /* @__PURE__ */ React.createElement("span", { className: "ct-shipping-opt-carrier" }, opt.carrier), opt.transit_days && /* @__PURE__ */ React.createElement("span", { className: "ct-shipping-opt-days" }, opt.transit_days, " day", opt.transit_days !== 1 ? "s" : "")),
      /* @__PURE__ */ React.createElement("span", { className: "ct-shipping-opt-price" }, "$", parseFloat(opt.amount).toFixed(2))
    ))), shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount === 0 && shippingEstimate.method === null && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line", style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("span", null, "Shipping"), /* @__PURE__ */ React.createElement("span", null, "$0.00")), shippingEstimate && shippingEstimate.weight_lbs > 0 && /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-weight" }, "Est. weight: ", shippingEstimate.weight_lbs, " lbs", shippingEstimate.weight_estimated ? " *" : ""), shippingEstimate && shippingEstimate.weight_estimated && /* @__PURE__ */ React.createElement("div", { className: "ct-shipping-weight", style: { fontSize: "0.75rem", color: "var(--stone-500)", marginTop: 2 } }, "* Some item weights estimated. Final shipping may vary."), shippingEstimate && shippingEstimate.method === "ltl_freight" && /* @__PURE__ */ React.createElement("label", { className: "ct-liftgate-toggle" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: liftgateEnabled, onChange: (e) => {
      setLiftgateEnabled(e.target.checked);
      setShippingEstimate(null);
      setSelectedShippingOption(null);
    } }), "Liftgate delivery (residential)")), deliveryMethod === "pickup" && /* @__PURE__ */ React.createElement("div", { className: "ct-summary-line", style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("span", null, "Shipping"), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--gold)" } }, "Free"))), /* @__PURE__ */ React.createElement("div", { className: "ct-summary-total" }, /* @__PURE__ */ React.createElement("span", { className: "ct-summary-total-label" }, selectedShippingOption ? "Estimated total" : "Subtotal"), /* @__PURE__ */ React.createElement("span", { className: "ct-summary-total-value" }, "$", cartTotal.toLocaleString(void 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))), /* @__PURE__ */ React.createElement("button", { className: "ct-checkout-btn", onClick: goCheckout, disabled: hasOutOfStock }, hasOutOfStock ? "Remove out-of-stock items to checkout" : "Checkout securely"), /* @__PURE__ */ React.createElement("div", { className: "ct-summary-trust" }, /* @__PURE__ */ React.createElement("div", null, "Secure checkout \xB7 Stripe"), /* @__PURE__ */ React.createElement("div", null, "(714) 999-0009"))))));
  }
  function CheckoutPage({ cart, sessionId, goCart, handleOrderComplete, deliveryMethod, setDeliveryMethod, liftgateEnabled, tradeCustomer, tradeToken, customer, customerToken, onCustomerLogin, klarnaError, clearKlarnaError, appliedPromoCode, setAppliedPromoCode }) {
    const [customerName, setCustomerName] = useState(tradeCustomer ? tradeCustomer.contact_name : customer ? customer.first_name + " " + customer.last_name : "");
    const [customerEmail, setCustomerEmail] = useState(tradeCustomer ? tradeCustomer.email : customer ? customer.email : "");
    const [phone, setPhone] = useState(customer ? customer.phone || "" : "");
    const [line1, setLine1] = useState(customer ? customer.address_line1 || "" : "");
    const [line2, setLine2] = useState(customer ? customer.address_line2 || "" : "");
    const [city, setCity] = useState(customer ? customer.city || "" : "");
    const [state, setState] = useState(customer ? customer.state || "" : "");
    const [zip, setZip] = useState(customer ? customer.zip || "" : "");
    const [error, setError] = useState("");
    const [processing, setProcessing] = useState(false);
    const [saveCard, setSaveCard] = useState(true);
    const [savedCards, setSavedCards] = useState([]);
    const [selectedSavedPm, setSelectedSavedPm] = useState(null);
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
    const [accountPassword, setAccountPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [passwordError, setPasswordError] = useState("");
    const [walletAvailable, setWalletAvailable] = useState(false);
    const paymentRequestRef = useRef(null);
    const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const [walletMode, setWalletMode] = useState(null);
    const [orderNotes, setOrderNotes] = useState("");
    const [editingContact, setEditingContact] = useState(!customer && !tradeCustomer);
    const [editingAddress, setEditingAddress] = useState(!customer || !customer.address_line1);
    const [measureRequested, setMeasureRequested] = useState(false);
    const [preferredDate, setPreferredDate] = useState("");
    const [preferredTime, setPreferredTime] = useState("");
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [termsError, setTermsError] = useState(false);
    const termsAcceptedRef = useRef(false);
    useEffect(() => {
      termsAcceptedRef.current = termsAccepted;
      if (termsAccepted) setTermsError(false);
    }, [termsAccepted]);
    const requireTermsAccepted = () => {
      if (termsAcceptedRef.current) return true;
      setTermsError(true);
      setError("Please accept the terms of service and privacy policy to place your order.");
      return false;
    };
    const cartEmpty = !cart || cart.length === 0;
    const isPickup = deliveryMethod === "pickup";
    const productItems = cart.filter((i) => !i.is_sample);
    const sampleItems = cart.filter((i) => i.is_sample);
    const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
    const sampleShipping = sampleItems.length > 0 ? 12 : 0;
    const promoDiscount = promoInfo ? parseFloat(promoInfo.discount_amount || 0) : 0;
    const taxableBase = Math.max(0, productSubtotal - promoDiscount);
    const estTax = Math.round(taxEstimate.rate * taxableBase * 100) / 100;
    const cartTotal = taxableBase + sampleShipping + estTax;
    const US_STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
    useEffect(() => {
      if (cartEmpty || cardMounted.current) return;
      let cancelled = false;
      ensureStripe().then((stripe) => {
        if (cancelled || !stripe || cardMounted.current) return;
        const el = document.getElementById("card-element");
        if (!el) return;
        const elements = stripe.elements();
        const card = elements.create("card", {
          style: { base: { fontFamily: "'Inter', sans-serif", fontSize: "15px", color: "#292524", "::placeholder": { color: "#57534e" } } }
        });
        card.mount(el);
        cardRef.current = card;
        cardMounted.current = true;
      });
      return () => {
        cancelled = true;
        if (cardRef.current) {
          cardRef.current.unmount();
          cardRef.current = null;
          cardMounted.current = false;
        }
      };
    }, [cartEmpty]);
    useEffect(() => {
      let cancelled = false;
      ensureStripe().then((stripe) => {
        if (cancelled || !stripe) return;
        const pr = stripe.paymentRequest({
          country: "US",
          currency: "usd",
          total: { label: "Roma Flooring Designs", amount: Math.round(cartTotal * 100) || 100 },
          requestPayerName: true,
          requestPayerEmail: true,
          requestPayerPhone: true
        });
        pr.canMakePayment().then((result) => {
          if (cancelled) return;
          if (result) {
            setWalletAvailable(true);
            setWalletMode("native");
            paymentRequestRef.current = pr;
          } else if (isLocalDev) {
            setWalletAvailable(true);
            setWalletMode("simulated");
          }
        });
      });
      return () => {
        cancelled = true;
      };
    }, []);
    useEffect(() => {
      if (walletMode !== "native" || !paymentRequestRef.current || !stripeInstance) return;
      const el = document.getElementById("payment-request-button");
      if (!el) return;
      const elements = stripeInstance.elements();
      const prButton = elements.create("paymentRequestButton", {
        paymentRequest: paymentRequestRef.current,
        style: { paymentRequestButton: { type: "default", theme: "dark", height: "48px" } }
      });
      prButton.on("click", (ev) => {
        if (!requireTermsAccepted()) ev.preventDefault();
      });
      prButton.mount("#payment-request-button");
      return () => prButton.unmount();
    }, [walletMode]);
    useEffect(() => {
      if (!paymentRequestRef.current) return;
      const amount = Math.round(cartTotal * 100);
      if (amount > 0) {
        paymentRequestRef.current.update({
          total: { label: "Roma Flooring Designs", amount }
        });
      }
    }, [cartTotal]);
    useEffect(() => {
      const pr = paymentRequestRef.current;
      if (!pr) return;
      const handler = async (ev) => {
        try {
          const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || void 0 };
          if (!isPickup) {
            piBody.destination = { zip, city, state };
            piBody.residential = true;
            piBody.liftgate = liftgateEnabled;
          }
          const piRes = await fetch(API + "/api/checkout/create-payment-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(piBody)
          });
          const piData = await piRes.json();
          if (piData.error) {
            ev.complete("fail");
            setError(piData.error);
            if (piData.out_of_stock_sku_ids) {
              setTimeout(() => {
                if (typeof goCart === "function") goCart();
              }, 3e3);
            }
            return;
          }
          const { error: confirmError, paymentIntent } = await stripeInstance.confirmCardPayment(
            piData.clientSecret,
            { payment_method: ev.paymentMethod.id },
            { handleActions: false }
          );
          if (confirmError) {
            ev.complete("fail");
            setError(confirmError.message);
            return;
          }
          ev.complete("success");
          if (paymentIntent.status === "requires_action") {
            const { error: actionError } = await stripeInstance.confirmCardPayment(piData.clientSecret);
            if (actionError) {
              setError(actionError.message);
              return;
            }
          }
          const payerName = ev.payerName || customerName;
          const payerEmail = ev.payerEmail || customerEmail;
          const payerPhone = ev.payerPhone || phone;
          const orderBody = {
            session_id: sessionId,
            payment_intent_id: paymentIntent.id,
            customer_name: payerName,
            customer_email: payerEmail,
            phone: payerPhone,
            delivery_method: deliveryMethod,
            shipping: isPickup ? null : { line1, line2, city, state, zip },
            residential: true,
            liftgate: liftgateEnabled,
            promo_code: appliedPromoCode || void 0,
            notes: orderNotes || void 0,
            measure_requested: measureRequested || void 0,
            preferred_measure_date: measureRequested && preferredDate ? preferredDate : void 0,
            preferred_measure_time: measureRequested && preferredTime ? preferredTime : void 0,
            terms_accepted: true
          };
          const orderHeaders = { "Content-Type": "application/json" };
          if (tradeToken) orderHeaders["X-Trade-Token"] = tradeToken;
          if (customerToken) orderHeaders["X-Customer-Token"] = customerToken;
          const orderRes = await fetch(API + "/api/checkout/place-order", {
            method: "POST",
            headers: orderHeaders,
            body: JSON.stringify(orderBody)
          });
          const orderData = await orderRes.json();
          if (orderData.error) {
            setError(orderData.error);
            return;
          }
          if (orderData.customer_token && orderData.customer && onCustomerLogin) {
            onCustomerLogin(orderData.customer_token, orderData.customer);
          }
          handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
        } catch (err) {
          ev.complete("fail");
          setError(err.message || "Wallet payment failed. Please try again.");
        }
      };
      pr.on("paymentmethod", handler);
      return () => pr.off("paymentmethod", handler);
    }, [walletAvailable, sessionId, deliveryMethod, isPickup, zip, city, state, line1, line2, customerName, customerEmail, phone, tradeToken, customerToken]);
    const handleSimulatedWalletPay = async () => {
      if (!cardRef.current) {
        setError("Card element not ready.");
        return;
      }
      if (!requireTermsAccepted()) return;
      setError("");
      setProcessing(true);
      try {
        const usingSavedCard = !!(customerToken && selectedSavedPm);
        const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || void 0 };
        if (!isPickup) {
          piBody.destination = { zip, city, state };
          piBody.residential = true;
          piBody.liftgate = liftgateEnabled;
        }
        if (usingSavedCard) piBody.saved_payment_method_id = selectedSavedPm;
        else if (customerToken && saveCard) piBody.save_card = true;
        const piHeaders = { "Content-Type": "application/json" };
        if (customerToken) piHeaders["X-Customer-Token"] = customerToken;
        const piRes = await fetch(API + "/api/checkout/create-payment-intent", {
          method: "POST",
          headers: piHeaders,
          body: JSON.stringify(piBody)
        });
        const piData = await piRes.json();
        if (piData.error) {
          setError(piData.error);
          setProcessing(false);
          if (piData.out_of_stock_sku_ids) {
            setTimeout(() => {
              if (typeof goCart === "function") goCart();
            }, 3e3);
          }
          return;
        }
        let confirmedPiId;
        if (usingSavedCard) {
          if (piData.status === "succeeded") {
            confirmedPiId = piData.paymentIntentId;
          } else if (piData.requires_action || piData.status === "requires_action") {
            const { error: actionError, paymentIntent: actionPi } = await stripeInstance.confirmCardPayment(piData.clientSecret);
            if (actionError) {
              setError(actionError.message);
              setProcessing(false);
              return;
            }
            confirmedPiId = actionPi.id;
          } else {
            setError("Your saved card could not be charged. Please try another card.");
            setProcessing(false);
            return;
          }
        } else {
          const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
            piData.clientSecret,
            { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
          );
          if (stripeError) {
            setError(stripeError.message);
            setProcessing(false);
            return;
          }
          confirmedPiId = paymentIntent.id;
        }
        const orderBody = {
          session_id: sessionId,
          payment_intent_id: confirmedPiId,
          customer_name: customerName,
          customer_email: customerEmail,
          phone,
          delivery_method: deliveryMethod,
          shipping: isPickup ? null : { line1, line2, city, state, zip },
          residential: true,
          liftgate: liftgateEnabled,
          promo_code: appliedPromoCode || void 0,
          create_account: createAccount || void 0,
          account_password: createAccount ? accountPassword : void 0,
          notes: orderNotes || void 0,
          measure_requested: measureRequested || void 0,
          preferred_measure_date: measureRequested && preferredDate ? preferredDate : void 0,
          preferred_measure_time: measureRequested && preferredTime ? preferredTime : void 0,
          terms_accepted: true
        };
        const orderHeaders = { "Content-Type": "application/json" };
        if (tradeToken) orderHeaders["X-Trade-Token"] = tradeToken;
        if (customerToken) orderHeaders["X-Customer-Token"] = customerToken;
        const orderRes = await fetch(API + "/api/checkout/place-order", {
          method: "POST",
          headers: orderHeaders,
          body: JSON.stringify(orderBody)
        });
        const orderData = await orderRes.json();
        if (orderData.error) {
          setError(orderData.error);
          setProcessing(false);
          return;
        }
        if (orderData.customer_token && orderData.customer && onCustomerLogin) {
          onCustomerLogin(orderData.customer_token, orderData.customer);
        }
        handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
      } catch (err) {
        setError(err.message || "Something went wrong. Please try again.");
        setProcessing(false);
      }
    };
    useEffect(() => {
      if (isPickup) return;
      let cancelled = false;
      fetch(API + "/api/config/google-places-key").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        if (cancelled || !data.key) return;
        return loadGooglePlaces(data.key).then(() => {
          if (!cancelled) setPlacesReady(true);
        });
      }).catch(() => {
      });
      return () => {
        cancelled = true;
      };
    }, [isPickup]);
    useEffect(() => {
      if (!placesReady || isPickup || !addressInputRef.current) return;
      if (autocompleteRef.current) return;
      try {
        const ac = new window.google.maps.places.Autocomplete(addressInputRef.current, {
          componentRestrictions: { country: "us" },
          fields: ["address_components", "formatted_address"],
          types: ["address"]
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          if (!place || !place.address_components) return;
          let streetNumber = "", route = "", newCity = "", newState = "", newZip = "";
          for (const comp of place.address_components) {
            const t = comp.types[0];
            if (t === "street_number") streetNumber = comp.long_name;
            else if (t === "route") route = comp.long_name;
            else if (t === "locality") newCity = comp.long_name;
            else if (t === "sublocality_level_1" && !newCity) newCity = comp.long_name;
            else if (t === "administrative_area_level_1") newState = comp.short_name;
            else if (t === "postal_code") newZip = comp.long_name;
          }
          setLine1((streetNumber + " " + route).trim());
          if (newCity) setCity(newCity);
          if (newState) setState(newState);
          if (newZip) setZip(newZip);
        });
        autocompleteRef.current = ac;
      } catch (e) {
      }
      return () => {
        if (autocompleteRef.current) {
          window.google.maps.event.clearInstanceListeners(autocompleteRef.current);
          autocompleteRef.current = null;
        }
      };
    }, [placesReady, isPickup]);
    useEffect(() => {
      if (prefilledRef.current || !customer) return;
      prefilledRef.current = true;
      const full = ((customer.first_name || "") + " " + (customer.last_name || "")).trim();
      setCustomerName((prev) => prev || full);
      setCustomerEmail((prev) => prev || customer.email || "");
      setPhone((prev) => prev || customer.phone || "");
      setLine1((prev) => prev || customer.address_line1 || "");
      setLine2((prev) => prev || customer.address_line2 || "");
      setCity((prev) => prev || customer.city || "");
      setState((prev) => prev || customer.state || "");
      setZip((prev) => prev || customer.zip || "");
      if (full && customer.email) setEditingContact(false);
      if (customer.address_line1) setEditingAddress(false);
    }, [customer]);
    useEffect(() => {
      if (!customerToken) {
        setSavedCards([]);
        return;
      }
      fetch(API + "/api/customer/payment-methods", { headers: { "X-Customer-Token": customerToken } }).then((r) => r.ok ? r.json() : { cards: [] }).then((d) => {
        const cards = d.cards || [];
        setSavedCards(cards);
        if (cards.length) setSelectedSavedPm(cards[0].id);
      }).catch(() => setSavedCards([]));
    }, [customerToken]);
    useEffect(() => {
      if (klarnaError) {
        setError(klarnaError);
        if (clearKlarnaError) clearKlarnaError();
      }
    }, []);
    useEffect(() => {
      const taxZip = isPickup ? "92806" : zip;
      if (!taxZip || taxZip.length < 5) {
        setTaxEstimate({ rate: 0, amount: 0 });
        return;
      }
      clearTimeout(taxDebounce.current);
      taxDebounce.current = setTimeout(async () => {
        try {
          const resp = await fetch(API + "/api/cart/tax-estimate?zip=" + encodeURIComponent(taxZip) + "&session_id=" + encodeURIComponent(sessionId));
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const data = await resp.json();
          setTaxEstimate({ rate: data.rate || 0, amount: data.amount || 0 });
        } catch (e) {
          setTaxEstimate({ rate: 0, amount: 0 });
        }
      }, 400);
      return () => clearTimeout(taxDebounce.current);
    }, [zip, isPickup, sessionId]);
    useEffect(() => {
      if (!appliedPromoCode || !sessionId) {
        setPromoInfo(null);
        return;
      }
      let cancelled = false;
      fetch(API + "/api/promo-codes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: appliedPromoCode, session_id: sessionId, customer_email: customerEmail || void 0 })
      }).then((r) => r.ok ? r.json() : { valid: false }).then((d) => {
        if (!cancelled) setPromoInfo(d && d.valid ? d : null);
      }).catch(() => {
        if (!cancelled) setPromoInfo(null);
      });
      return () => {
        cancelled = true;
      };
    }, [appliedPromoCode, sessionId, productSubtotal]);
    const handleSubmit = async (e) => {
      e.preventDefault();
      setError("");
      setPasswordError("");
      const nameParts = customerName.trim().split(/\s+/);
      if (nameParts.length < 2 || nameParts[0].length < 2 || nameParts[1].length < 1) {
        setError("Please enter your full name (first and last).");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail)) {
        setError("Please enter a valid email address.");
        return;
      }
      if (phone.replace(/\D/g, "").length < 10) {
        setError("Please enter a valid 10-digit phone number.");
        return;
      }
      if (!isPickup) {
        if (!line1.trim()) {
          setError("Please enter a street address.");
          return;
        }
        if (!city.trim()) {
          setError("Please enter a city.");
          return;
        }
        if (!state) {
          setError("Please select a state.");
          return;
        }
        if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
          setError("Please enter a valid ZIP code.");
          return;
        }
      }
      if (createAccount) {
        if (accountPassword.length < 8 || !/[A-Z]/.test(accountPassword) || !/[0-9]/.test(accountPassword)) {
          setPasswordError("Password must be at least 8 characters with 1 uppercase letter and 1 number.");
          return;
        }
        if (accountPassword !== confirmPassword) {
          setPasswordError("Passwords do not match.");
          return;
        }
      }
      if (!requireTermsAccepted()) return;
      setProcessing(true);
      try {
        const usingSavedCard = !!(customerToken && selectedSavedPm);
        const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || void 0 };
        if (!isPickup) {
          piBody.destination = { zip, city, state };
          piBody.residential = true;
          piBody.liftgate = liftgateEnabled;
        }
        if (usingSavedCard) piBody.saved_payment_method_id = selectedSavedPm;
        else if (customerToken && saveCard) piBody.save_card = true;
        const piHeaders = { "Content-Type": "application/json" };
        if (customerToken) piHeaders["X-Customer-Token"] = customerToken;
        const piRes = await fetch(API + "/api/checkout/create-payment-intent", {
          method: "POST",
          headers: piHeaders,
          body: JSON.stringify(piBody)
        });
        const piData = await piRes.json();
        if (piData.error) {
          setError(piData.error);
          setProcessing(false);
          if (piData.out_of_stock_sku_ids) {
            setTimeout(() => {
              if (typeof goCart === "function") goCart();
            }, 3e3);
          }
          return;
        }
        let confirmedPiId;
        if (usingSavedCard) {
          if (piData.status === "succeeded") {
            confirmedPiId = piData.paymentIntentId;
          } else if (piData.requires_action || piData.status === "requires_action") {
            const { error: actionError, paymentIntent: actionPi } = await stripeInstance.confirmCardPayment(piData.clientSecret);
            if (actionError) {
              setError(actionError.message);
              setProcessing(false);
              return;
            }
            confirmedPiId = actionPi.id;
          } else {
            setError("Your saved card could not be charged. Please try another card.");
            setProcessing(false);
            return;
          }
        } else {
          const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
            piData.clientSecret,
            { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
          );
          if (stripeError) {
            setError(stripeError.message);
            setProcessing(false);
            return;
          }
          confirmedPiId = paymentIntent.id;
        }
        const orderBody = {
          session_id: sessionId,
          payment_intent_id: confirmedPiId,
          customer_name: customerName,
          customer_email: customerEmail,
          phone,
          delivery_method: deliveryMethod,
          shipping: isPickup ? null : { line1, line2, city, state, zip },
          residential: true,
          liftgate: liftgateEnabled,
          promo_code: appliedPromoCode || void 0,
          create_account: createAccount || void 0,
          account_password: createAccount ? accountPassword : void 0,
          notes: orderNotes || void 0,
          measure_requested: measureRequested || void 0,
          preferred_measure_date: measureRequested && preferredDate ? preferredDate : void 0,
          preferred_measure_time: measureRequested && preferredTime ? preferredTime : void 0,
          terms_accepted: true
        };
        const orderHeaders = { "Content-Type": "application/json" };
        if (tradeToken) orderHeaders["X-Trade-Token"] = tradeToken;
        if (customerToken) orderHeaders["X-Customer-Token"] = customerToken;
        const orderRes = await fetch(API + "/api/checkout/place-order", {
          method: "POST",
          headers: orderHeaders,
          body: JSON.stringify(orderBody)
        });
        const orderData = await orderRes.json();
        if (orderData.error) {
          setError(orderData.error);
          setProcessing(false);
          return;
        }
        if (orderData.customer_token && orderData.customer && onCustomerLogin) {
          onCustomerLogin(orderData.customer_token, orderData.customer);
        }
        handleOrderComplete({ order: orderData.order, sample_request: orderData.sample_request || null });
      } catch (err) {
        setError(err.message || "Something went wrong. Please try again.");
        setProcessing(false);
      }
    };
    const handleKlarnaPay = async () => {
      setError("");
      const nameParts = customerName.trim().split(/\s+/);
      if (nameParts.length < 2 || nameParts[0].length < 2 || nameParts[1].length < 1) {
        setError("Please enter your full name (first and last).");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail)) {
        setError("Please enter a valid email address.");
        return;
      }
      if (phone.replace(/\D/g, "").length < 10) {
        setError("Please enter a valid 10-digit phone number.");
        return;
      }
      if (!isPickup) {
        if (!line1.trim()) {
          setError("Please enter a street address.");
          return;
        }
        if (!city.trim()) {
          setError("Please enter a city.");
          return;
        }
        if (!state) {
          setError("Please select a state.");
          return;
        }
        if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
          setError("Please enter a valid ZIP code.");
          return;
        }
      }
      if (!requireTermsAccepted()) return;
      setProcessing(true);
      try {
        const stripe = await ensureStripe();
        if (!stripe) {
          setError("Payment system is still loading \u2014 please try again in a moment.");
          setProcessing(false);
          return;
        }
        const piBody = { session_id: sessionId, delivery_method: deliveryMethod, promo_code: appliedPromoCode || void 0 };
        if (!isPickup) {
          piBody.destination = { zip, city, state };
          piBody.residential = true;
          piBody.liftgate = liftgateEnabled;
        }
        const piHeaders = { "Content-Type": "application/json" };
        if (customerToken) piHeaders["X-Customer-Token"] = customerToken;
        const piRes = await fetch(API + "/api/checkout/create-payment-intent", { method: "POST", headers: piHeaders, body: JSON.stringify(piBody) });
        const piData = await piRes.json();
        if (piData.error) {
          setError(piData.error);
          setProcessing(false);
          if (piData.out_of_stock_sku_ids) {
            setTimeout(() => {
              if (typeof goCart === "function") goCart();
            }, 3e3);
          }
          return;
        }
        const orderBody = {
          session_id: sessionId,
          customer_name: customerName,
          customer_email: customerEmail,
          phone,
          delivery_method: deliveryMethod,
          shipping: isPickup ? null : { line1, line2, city, state, zip },
          residential: true,
          liftgate: liftgateEnabled,
          promo_code: appliedPromoCode || void 0,
          create_account: createAccount || void 0,
          account_password: createAccount ? accountPassword : void 0,
          notes: orderNotes || void 0,
          measure_requested: measureRequested || void 0,
          preferred_measure_date: measureRequested && preferredDate ? preferredDate : void 0,
          preferred_measure_time: measureRequested && preferredTime ? preferredTime : void 0,
          terms_accepted: true
        };
        sessionStorage.setItem("klarna_pending", JSON.stringify({ orderBody, ts: Date.now() }));
        const billingAddress = isPickup ? { country: "US", postal_code: "92806" } : { country: "US", line1, line2: line2 || void 0, city, state, postal_code: zip };
        const { error: kErr } = await stripe.confirmKlarnaPayment(piData.clientSecret, {
          payment_method: { billing_details: { name: customerName, email: customerEmail, phone, address: billingAddress } },
          return_url: window.location.origin + "/checkout"
        });
        if (kErr) {
          setError(kErr.message);
          sessionStorage.removeItem("klarna_pending");
          setProcessing(false);
        }
      } catch (err) {
        setError("Klarna could not be started. Please try again or pay by card.");
        sessionStorage.removeItem("klarna_pending");
        setProcessing(false);
      }
    };
    const contactSaved = customerName.trim().length > 2 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail) && phone.replace(/\D/g, "").length >= 10;
    const addressSaved = isPickup || line1.trim() && city.trim() && state && /^\d{5}(-\d{4})?$/.test(zip.trim());
    const initials = customerName.trim().split(/\s+/).map((n) => n[0] || "").join("").toUpperCase().slice(0, 2);
    const formatPhone = (val) => {
      const digits = val.replace(/\D/g, "").slice(0, 10);
      let fmt = "";
      if (digits.length > 0) fmt = "(" + digits.slice(0, 3);
      if (digits.length >= 3) fmt += ") ";
      if (digits.length > 3) fmt += digits.slice(3, 6);
      if (digits.length >= 6) fmt += "-" + digits.slice(6);
      return fmt;
    };
    if (cartEmpty) {
      return /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem 1rem" } }, /* @__PURE__ */ React.createElement("h2", null, "Your cart is empty"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", margin: "1rem 0" } }, "Add items to your cart before checking out."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goCart }, "Go to Cart"));
    }
    return /* @__PURE__ */ React.createElement("div", { className: "co-wrap" }, /* @__PURE__ */ React.createElement("div", { className: "co-header" }, /* @__PURE__ */ React.createElement("a", { className: "co-header-logo", onClick: (e) => {
      e.preventDefault();
      goCart();
    }, href: "#" }, "Roma"), /* @__PURE__ */ React.createElement("div", { className: "co-header-meta" }, /* @__PURE__ */ React.createElement("span", { className: "co-phone" }, "(714) 999-0009"), /* @__PURE__ */ React.createElement("span", { className: "co-secure" }, /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M7 11V7a5 5 0 0110 0v4" })), "Secure checkout"))), /* @__PURE__ */ React.createElement("div", { className: "co-progress" }, /* @__PURE__ */ React.createElement("div", { className: "co-progress-inner" }, /* @__PURE__ */ React.createElement("div", { className: "co-progress-step" }, /* @__PURE__ */ React.createElement("div", { className: "co-progress-dot past" }, /* @__PURE__ */ React.createElement("svg", { width: "10", height: "10", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "3" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-progress-label" }, "Cart"), /* @__PURE__ */ React.createElement("div", { className: "co-progress-status" }, "Complete"))), /* @__PURE__ */ React.createElement("div", { className: "co-progress-step" }, /* @__PURE__ */ React.createElement("div", { className: "co-progress-dot current" }, "2"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-progress-label" }, "Checkout"), /* @__PURE__ */ React.createElement("div", { className: "co-progress-status" }, "In progress"))), /* @__PURE__ */ React.createElement("div", { className: "co-progress-step" }, /* @__PURE__ */ React.createElement("div", { className: "co-progress-dot future" }, "3"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-progress-label" }, "Confirmation"), /* @__PURE__ */ React.createElement("div", { className: "co-progress-status" }, "\u2014"))))), /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit }, /* @__PURE__ */ React.createElement("div", { className: "co-grid" }, /* @__PURE__ */ React.createElement("div", { className: "co-steps" }, error && /* @__PURE__ */ React.createElement("div", { className: "co-error" }, error), /* @__PURE__ */ React.createElement("div", { className: `co-step ${editingContact ? "focus" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: `co-step-num ${contactSaved && !editingContact ? "saved" : ""}` }, "01"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Contact")), contactSaved && !editingContact && /* @__PURE__ */ React.createElement("div", { className: "co-step-chip" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-chip-label", style: { color: "var(--gold)" } }, "Saved"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "co-step-chip-action", onClick: () => setEditingContact(true) }, "Edit"))), editingContact ? /* @__PURE__ */ React.createElement("div", { className: "co-form-grid" }, /* @__PURE__ */ React.createElement("div", { className: "co-form-row-2" }, /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Full name"), /* @__PURE__ */ React.createElement("input", { value: customerName, onChange: (e) => setCustomerName(e.target.value), placeholder: "John Smith" })), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Email"), /* @__PURE__ */ React.createElement("input", { type: "email", value: customerEmail, onChange: (e) => setCustomerEmail(e.target.value), placeholder: "john@example.com" }))), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Phone"), /* @__PURE__ */ React.createElement("input", { type: "tel", value: phone, onChange: (e) => setPhone(formatPhone(e.target.value)), placeholder: "(555) 123-4567" })), !customer && !tradeCustomer && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("label", { className: "co-create-account" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: createAccount, onChange: (e) => {
      setCreateAccount(e.target.checked);
      if (!e.target.checked) {
        setAccountPassword("");
        setConfirmPassword("");
        setPasswordError("");
      }
    } }), "Create an account for faster checkout"), createAccount && /* @__PURE__ */ React.createElement("div", { className: "co-password-fields" }, /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: accountPassword, onChange: (e) => {
      setAccountPassword(e.target.value);
      setPasswordError("");
    }, placeholder: "Min 8 chars, 1 uppercase, 1 number", autoComplete: "new-password" })), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Confirm password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: confirmPassword, onChange: (e) => {
      setConfirmPassword(e.target.value);
      setPasswordError("");
    }, placeholder: "Re-enter password", autoComplete: "new-password" })), passwordError && /* @__PURE__ */ React.createElement("div", { className: "co-password-error" }, passwordError))), contactSaved && /* @__PURE__ */ React.createElement("button", { type: "button", style: { marginTop: "0.5rem", padding: "0.75rem", background: "var(--stone-800)", color: "var(--warm-bg)", border: "none", font: "500 0.75rem/1 var(--font-body)", letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer" }, onClick: () => setEditingContact(false) }, "Save contact")) : /* @__PURE__ */ React.createElement("div", { className: "co-contact-saved" }, /* @__PURE__ */ React.createElement("div", { className: "co-contact-avatar" }, initials || "?"), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-contact-info" }, customerName, " \xB7 ", customerEmail), phone && /* @__PURE__ */ React.createElement("div", { className: "co-contact-meta" }, phone), tradeCustomer && /* @__PURE__ */ React.createElement("div", { className: "co-contact-meta" }, "Trade account \xB7 ", tradeCustomer.company_name)))), /* @__PURE__ */ React.createElement("div", { className: "co-step focus" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-num" }, "02"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Delivery"))), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-grid" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: `co-delivery-card ${isPickup ? "selected" : ""}`, onClick: () => {
      if (typeof setDeliveryMethod === "function") setDeliveryMethod("pickup");
    } }, /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-top" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-name" }, "Showroom Pickup"), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-meta" }, "Anaheim, CA")), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-cost" }, "FREE")), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-sub" }, "Roma Flooring Designs, 1440 S. State College Blvd."), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-eta" }, "Ready in 3-5 business days")), /* @__PURE__ */ React.createElement("button", { type: "button", className: `co-delivery-card ${!isPickup ? "selected" : ""}`, onClick: () => {
      if (typeof setDeliveryMethod === "function") setDeliveryMethod("shipping");
    } }, /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-top" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-name" }, "Freight"), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-meta" }, "Orange County")), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-cost" }, "Quoted")), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-sub" }, "We deliver within the greater Anaheim area"), /* @__PURE__ */ React.createElement("div", { className: "co-delivery-card-eta" }, "Scheduled after order")))), /* @__PURE__ */ React.createElement("div", { className: `co-step ${!isPickup && editingAddress ? "focus" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: `co-step-num ${addressSaved && !editingAddress ? "saved" : ""}` }, "03"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Address")), !isPickup && addressSaved && !editingAddress && /* @__PURE__ */ React.createElement("div", { className: "co-step-chip" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-chip-label", style: { color: "var(--gold)" } }, "Saved"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "co-step-chip-action", onClick: () => setEditingAddress(true) }, "Edit")), isPickup && /* @__PURE__ */ React.createElement("div", { className: "co-step-chip" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-chip-label", style: { color: "var(--gold)" } }, "Pickup"))), isPickup ? /* @__PURE__ */ React.createElement("div", { className: "co-pickup-info" }, /* @__PURE__ */ React.createElement("div", { className: "co-pickup-label" }, "Pickup location"), /* @__PURE__ */ React.createElement("div", { className: "co-pickup-name" }, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("div", { className: "co-pickup-addr" }, "1440 S. State College Blvd., Suite 6M, Anaheim, CA 92806"), /* @__PURE__ */ React.createElement("div", { className: "co-pickup-ready" }, "Ready in 3-5 business days")) : editingAddress ? /* @__PURE__ */ React.createElement("div", { className: "co-form-grid" }, /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Address line 1"), /* @__PURE__ */ React.createElement("input", { ref: addressInputRef, value: line1, onChange: (e) => setLine1(e.target.value), placeholder: "Start typing an address...", autoComplete: "off" })), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Address line 2"), /* @__PURE__ */ React.createElement("input", { value: line2, onChange: (e) => setLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { className: "co-form-row-3" }, /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "City"), /* @__PURE__ */ React.createElement("input", { value: city, onChange: (e) => setCity(e.target.value), placeholder: "Anaheim" })), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "State"), /* @__PURE__ */ React.createElement("select", { value: state, onChange: (e) => setState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "ZIP"), /* @__PURE__ */ React.createElement("input", { value: zip, onChange: (e) => setZip(e.target.value), placeholder: "92806" }))), addressSaved && /* @__PURE__ */ React.createElement("button", { type: "button", style: { marginTop: "0.5rem", padding: "0.75rem", background: "var(--stone-800)", color: "var(--warm-bg)", border: "none", font: "500 0.75rem/1 var(--font-body)", letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer" }, onClick: () => setEditingAddress(false) }, "Save address")) : /* @__PURE__ */ React.createElement("div", { className: "co-address-saved" }, /* @__PURE__ */ React.createElement("div", { className: "co-address-text" }, line1, line2 ? ", " + line2 : "", /* @__PURE__ */ React.createElement("br", null), city, ", ", state, " ", zip))), /* @__PURE__ */ React.createElement("div", { className: `co-step ${measureRequested ? "focus" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-num" }, "04"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Installation")), /* @__PURE__ */ React.createElement("div", { className: "co-step-chip" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-chip-label", style: { color: measureRequested ? "var(--gold)" : "var(--warm-muted)" } }, measureRequested ? "Requested" : "Optional"))), /* @__PURE__ */ React.createElement("label", { className: `co-measure-toggle ${measureRequested ? "active" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "co-measure-toggle-left" }, /* @__PURE__ */ React.createElement("div", { className: "co-measure-offer-label" }, "Free estimate"), /* @__PURE__ */ React.createElement("div", { className: "co-measure-offer-title" }, "Get an installation quote"), /* @__PURE__ */ React.createElement("div", { className: "co-measure-offer-sub" }, "We'll measure your space and provide a detailed installation estimate.")), /* @__PURE__ */ React.createElement("div", { className: `co-toggle-switch ${measureRequested ? "on" : ""}`, onClick: () => {
      setMeasureRequested(!measureRequested);
      if (measureRequested) {
        setPreferredDate("");
        setPreferredTime("");
      }
    } }, /* @__PURE__ */ React.createElement("div", { className: "co-toggle-knob" }))), measureRequested && /* @__PURE__ */ React.createElement("div", { className: "co-schedule-fields" }, /* @__PURE__ */ React.createElement("div", { className: "co-schedule-row" }, /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Preferred date"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "date",
        value: preferredDate,
        onChange: (e) => setPreferredDate(e.target.value),
        min: (() => {
          const d = /* @__PURE__ */ new Date();
          d.setDate(d.getDate() + 3);
          return d.toISOString().split("T")[0];
        })(),
        max: (() => {
          const d = /* @__PURE__ */ new Date();
          d.setDate(d.getDate() + 60);
          return d.toISOString().split("T")[0];
        })()
      }
    )), /* @__PURE__ */ React.createElement("div", { className: "co-field" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Time window"), /* @__PURE__ */ React.createElement("div", { className: "co-time-slots" }, [["morning", "Morning", "8am \u2013 12pm"], ["afternoon", "Afternoon", "12 \u2013 4pm"], ["evening", "Evening", "4 \u2013 7pm"]].map(([val, label, sub]) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: val,
        type: "button",
        className: `co-time-slot ${preferredTime === val ? "selected" : ""}`,
        onClick: () => setPreferredTime(preferredTime === val ? "" : val)
      },
      /* @__PURE__ */ React.createElement("span", { className: "co-time-slot-label" }, label),
      /* @__PURE__ */ React.createElement("span", { className: "co-time-slot-sub" }, sub)
    ))))), /* @__PURE__ */ React.createElement("div", { className: "co-schedule-note" }, "We'll confirm your appointment within 24 hours. Dates subject to availability."))), /* @__PURE__ */ React.createElement("div", { className: "co-step focus" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-num" }, "05"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Payment"))), walletAvailable && /* @__PURE__ */ React.createElement("div", { className: "co-express-section" }, walletMode === "native" ? /* @__PURE__ */ React.createElement("div", { id: "payment-request-button" }) : /* @__PURE__ */ React.createElement("button", { type: "button", className: "co-wallet-btn", onClick: handleSimulatedWalletPay, disabled: processing }, /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "4", width: "22", height: "16", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "10", x2: "23", y2: "10" })), processing ? "Processing..." : "Pay with Wallet", isLocalDev && /* @__PURE__ */ React.createElement("span", { className: "dev-badge" }, "DEV")), /* @__PURE__ */ React.createElement("div", { className: "co-divider" }, "or pay with card")), savedCards.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "co-saved-cards" }, savedCards.map((c) => /* @__PURE__ */ React.createElement("label", { key: c.id, className: "co-saved-card" + (selectedSavedPm === c.id ? " selected" : "") }, /* @__PURE__ */ React.createElement("input", { type: "radio", name: "coSavedPm", checked: selectedSavedPm === c.id, onChange: () => setSelectedSavedPm(c.id) }), /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "4", width: "22", height: "16", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "10", x2: "23", y2: "10" })), /* @__PURE__ */ React.createElement("span", { className: "co-saved-card-brand" }, c.brand), /* @__PURE__ */ React.createElement("span", { className: "co-saved-card-num" }, "\u2022\u2022\u2022\u2022 ", c.last4), /* @__PURE__ */ React.createElement("span", { className: "co-saved-card-exp" }, "Exp ", String(c.exp_month).padStart(2, "0"), "/", String(c.exp_year).slice(-2)))), /* @__PURE__ */ React.createElement("label", { className: "co-saved-card" + (selectedSavedPm === null ? " selected" : "") }, /* @__PURE__ */ React.createElement("input", { type: "radio", name: "coSavedPm", checked: selectedSavedPm === null, onChange: () => setSelectedSavedPm(null) }), /* @__PURE__ */ React.createElement("span", { className: "co-saved-card-brand" }, "Use a new card"))), /* @__PURE__ */ React.createElement("div", { className: "co-card-form", style: { display: savedCards.length > 0 && selectedSavedPm ? "none" : "block" } }, /* @__PURE__ */ React.createElement("div", { className: "co-stripe-wrap" }, /* @__PURE__ */ React.createElement("div", { className: "co-field-label" }, "Card number"), /* @__PURE__ */ React.createElement("div", { id: "card-element" })), customerToken ? /* @__PURE__ */ React.createElement("label", { className: "co-save-card" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: saveCard, onChange: (e) => setSaveCard(e.target.checked) }), " Save card for future orders") : null), /* @__PURE__ */ React.createElement("div", { className: "co-divider" }, "or"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "co-klarna-btn", onClick: handleKlarnaPay, disabled: processing }, "Pay with ", /* @__PURE__ */ React.createElement("span", { className: "co-klarna-word" }, "Klarna.")), /* @__PURE__ */ React.createElement("div", { className: "co-klarna-note" }, "Split into 4 interest-free payments. You'll finish on Klarna, then come right back.")), /* @__PURE__ */ React.createElement("div", { className: "co-step" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-head" }, /* @__PURE__ */ React.createElement("div", { className: "co-step-left" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-num" }, "06"), /* @__PURE__ */ React.createElement("h3", { className: "co-step-title" }, "Notes")), /* @__PURE__ */ React.createElement("div", { className: "co-step-chip" }, /* @__PURE__ */ React.createElement("span", { className: "co-step-chip-label", style: { color: "var(--warm-muted)" } }, "Optional"))), /* @__PURE__ */ React.createElement("div", { className: "co-notes" }, /* @__PURE__ */ React.createElement("textarea", { value: orderNotes, onChange: (e) => setOrderNotes(e.target.value), placeholder: "Delivery instructions, gate codes, special requests..." }), /* @__PURE__ */ React.createElement("div", { className: "co-notes-hint" }, "Visible to your project manager"))), /* @__PURE__ */ React.createElement("label", { className: "co-terms co-terms-check" + (termsError ? " co-terms-invalid" : "") }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: termsAccepted, onChange: (e) => setTermsAccepted(e.target.checked) }), /* @__PURE__ */ React.createElement("span", null, "I have read and agree to Roma's", " ", /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "terms of service"), " and", " ", /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "privacy policy"), ".")), termsError && /* @__PURE__ */ React.createElement("div", { className: "co-terms-error-msg" }, "Please check the box above to place your order."), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "co-place-order", disabled: processing }, processing && /* @__PURE__ */ React.createElement("span", { className: "co-spinner" }), processing ? "Processing..." : `Place Order \u2014 $${cartTotal.toFixed(2)}`)), /* @__PURE__ */ React.createElement("div", { className: "co-summary" }, /* @__PURE__ */ React.createElement("div", { className: "co-summary-box" }, /* @__PURE__ */ React.createElement("div", { className: "co-summary-header" }, "Order summary"), /* @__PURE__ */ React.createElement("div", { className: "co-summary-items" }, cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "co-summary-item" }, /* @__PURE__ */ React.createElement("div", { className: "co-summary-thumb" }, item.primary_image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(item.primary_image, 144), alt: "", decoding: "async", loading: "lazy", style: { width: "100%", height: "100%", objectFit: "cover" } }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-200)" } }), !item.is_sample && /* @__PURE__ */ React.createElement("div", { className: "co-summary-thumb-badge" }, item.num_boxes)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "co-summary-item-name" }, item.product_name || "Product"), /* @__PURE__ */ React.createElement("div", { className: "co-summary-item-detail" }, item.is_sample ? "Free sample" : item.sell_by === "unit" ? `Qty ${item.num_boxes}` : `${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? "es" : ""}`)), /* @__PURE__ */ React.createElement("div", { className: "co-summary-item-price" }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2))))), /* @__PURE__ */ React.createElement("div", { className: "co-summary-totals" }, /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Subtotal"), /* @__PURE__ */ React.createElement("span", { className: "value" }, "$", productSubtotal.toFixed(2))), promoDiscount > 0 && /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Discount", promoInfo && promoInfo.code ? " \xB7 " + promoInfo.code : ""), /* @__PURE__ */ React.createElement("span", { className: "value", style: { color: "#4a7c3e" } }, "\u2212$", promoDiscount.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Sample shipping"), /* @__PURE__ */ React.createElement("span", { className: "value" }, "$12.00")), taxEstimate.rate > 0 ? /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Tax (", (taxEstimate.rate * 100).toFixed(2), "%)"), /* @__PURE__ */ React.createElement("span", { className: "value" }, "$", estTax.toFixed(2))) : !isPickup && /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Tax"), /* @__PURE__ */ React.createElement("span", { className: "value", style: { color: "var(--stone-500)", fontStyle: "italic" } }, "Calculated with address")), isPickup && /* @__PURE__ */ React.createElement("div", { className: "co-summary-row" }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Delivery"), /* @__PURE__ */ React.createElement("span", { className: "value" }, "Pickup \u2014 Free"))), /* @__PURE__ */ React.createElement("div", { className: "co-summary-total" }, /* @__PURE__ */ React.createElement("span", { className: "co-summary-total-label" }, "Total"), /* @__PURE__ */ React.createElement("span", { className: "co-summary-total-amount" }, "$", cartTotal.toFixed(2)))), /* @__PURE__ */ React.createElement("a", { className: "co-summary-edit-cart", href: "#", onClick: (e) => {
      e.preventDefault();
      goCart();
    } }, "\u2190 Edit cart"), /* @__PURE__ */ React.createElement("div", { className: "co-summary-trust" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "0.5rem" } }, /* @__PURE__ */ React.createElement("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M7 11V7a5 5 0 0110 0v4" })), "256-bit TLS encryption"))))), /* @__PURE__ */ React.createElement("div", { className: "co-footer" }, /* @__PURE__ */ React.createElement("span", null, "\xA9 ", (/* @__PURE__ */ new Date()).getFullYear(), " Roma Flooring Designs"), /* @__PURE__ */ React.createElement("div", { className: "co-footer-links" }, /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms"), /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "Privacy"), /* @__PURE__ */ React.createElement("a", { href: "#" }, "Returns"))));
  }
  function ConfirmationPage({ orderData, goBrowse }) {
    if (!orderData) return null;
    const order = orderData.order;
    const sampleRequest = orderData.sample_request;
    const items = order ? order.items || [] : [];
    const sampleItems = sampleRequest ? sampleRequest.items || [] : [];
    const orderTotal = order ? parseFloat(order.total || 0) : 0;
    return /* @__PURE__ */ React.createElement("div", { className: "conf-wrap" }, /* @__PURE__ */ React.createElement("div", { className: "conf-hero" }, /* @__PURE__ */ React.createElement("div", { className: "conf-check" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h1", null, "Thank You"), order && /* @__PURE__ */ React.createElement("div", { className: "conf-order-num" }, "Order ", order.order_number), /* @__PURE__ */ React.createElement("div", { className: "conf-hero-sub" }, "Your order has been placed. We\u2019ll send a confirmation to your email with tracking details once your order ships.")), items.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "conf-items" }, /* @__PURE__ */ React.createElement("div", { className: "conf-items-header" }, "Items ordered"), items.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "conf-item" }, /* @__PURE__ */ React.createElement("div", { className: "conf-item-thumb" }, item.primary_image ? /* @__PURE__ */ React.createElement("img", { src: optimizeImg(item.primary_image, 144), alt: "", decoding: "async", loading: "lazy" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-200)" } })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "conf-item-name" }, item.product_name || "Product"), /* @__PURE__ */ React.createElement("div", { className: "conf-item-detail" }, item.sell_by === "unit" ? `Qty ${item.num_boxes}` : `${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? "es" : ""}`)), /* @__PURE__ */ React.createElement("div", { className: "conf-item-price" }, "$" + parseFloat(item.subtotal || 0).toFixed(2)))), /* @__PURE__ */ React.createElement("div", { className: "conf-item-total-row" }, /* @__PURE__ */ React.createElement("span", { className: "conf-item-total-label" }, "Total paid"), /* @__PURE__ */ React.createElement("span", { className: "conf-item-total-amount" }, "$", orderTotal.toFixed(2)))), sampleRequest && /* @__PURE__ */ React.createElement("div", { className: "conf-samples" }, /* @__PURE__ */ React.createElement("div", { className: "conf-samples-header" }, /* @__PURE__ */ React.createElement("span", { className: "conf-samples-badge" }, "Samples"), /* @__PURE__ */ React.createElement("span", { className: "conf-samples-title" }, "Request #", sampleRequest.request_number)), sampleItems.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "conf-sample-item" }, /* @__PURE__ */ React.createElement("span", null, item.product_name || "Product", item.variant_name ? " \u2014 " + item.variant_name : ""), /* @__PURE__ */ React.createElement("span", { className: "conf-sample-free" }, "Free"))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--warm-muted)", marginTop: "0.75rem" } }, "Samples ship separately within 2-3 business days.")), /* @__PURE__ */ React.createElement("div", { className: "conf-details" }, /* @__PURE__ */ React.createElement("div", { className: "conf-detail-card" }, /* @__PURE__ */ React.createElement("div", { className: "conf-detail-label" }, "Delivery"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-title" }, order && order.delivery_method === "pickup" ? "Showroom Pickup" : "Freight"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text" }, order && order.delivery_method === "pickup" ? "1440 S. State College Blvd., Suite 6M, Anaheim, CA 92806" : order && order.shipping_address ? `${order.shipping_address.line1}, ${order.shipping_address.city}, ${order.shipping_address.state} ${order.shipping_address.zip}` : "Address on file"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text", style: { marginTop: "0.5rem" } }, order && order.delivery_method === "pickup" ? "Ready in 3-5 business days" : "Delivery scheduled after confirmation")), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-card" }, /* @__PURE__ */ React.createElement("div", { className: "conf-detail-label" }, "Payment"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-title" }, order && order.card_last4 ? (order.card_brand ? order.card_brand.charAt(0).toUpperCase() + order.card_brand.slice(1) + " " : "Card ") + "ending in " + order.card_last4 : order && order.payment_method === "klarna" ? "Klarna" : order && order.payment_method === "bank_transfer" ? "Bank transfer" : "Card payment"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text" }, "Total charged: $", orderTotal.toFixed(2)), order && order.tax_amount > 0 && /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text" }, "Includes $", parseFloat(order.tax_amount).toFixed(2), " tax")), order && order.measure_requested && /* @__PURE__ */ React.createElement("div", { className: "conf-detail-card" }, /* @__PURE__ */ React.createElement("div", { className: "conf-detail-label" }, "Installation quote"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-title" }, "Requested"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text" }, order.preferred_measure_date ? (/* @__PURE__ */ new Date(order.preferred_measure_date + "T12:00:00")).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Date to be confirmed", order.preferred_measure_time && ` \u2014 ${order.preferred_measure_time.charAt(0).toUpperCase() + order.preferred_measure_time.slice(1)}`), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text", style: { marginTop: "0.5rem" } }, "We'll confirm your appointment within 24 hours.")), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-card" }, /* @__PURE__ */ React.createElement("div", { className: "conf-detail-label" }, "Your contact"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-title" }, "Lia Romano"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text" }, "Project Manager", /* @__PURE__ */ React.createElement("br", null), "lia@romaflooringdesigns.com", /* @__PURE__ */ React.createElement("br", null), "(714) 999-0009"), /* @__PURE__ */ React.createElement("div", { className: "conf-detail-text", style: { marginTop: "0.5rem", fontStyle: "italic" } }, `"We'll be in touch within 24 hours."`))), /* @__PURE__ */ React.createElement("div", { className: "conf-cta" }, /* @__PURE__ */ React.createElement("button", { className: "conf-cta-btn", onClick: goBrowse }, "Continue Shopping")));
  }
  function PaymentMethodsSection({ customerToken, customer }) {
    const [cards, setCards] = useState(null);
    const [showAdd, setShowAdd] = useState(false);
    const [cardComplete, setCardComplete] = useState(false);
    const [cardError, setCardError] = useState("");
    const [savingCard, setSavingCard] = useState(false);
    const [removing, setRemoving] = useState(null);
    const [msg, setMsg] = useState("");
    const cardElRef = useRef(null);
    const mountRef = useRef(null);
    const authHeaders = { "X-Customer-Token": customerToken };
    const loadCards = () => {
      fetch(API + "/api/customer/payment-methods", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setCards(data.cards || [])).catch(() => setCards([]));
    };
    useEffect(loadCards, []);
    useEffect(() => {
      if (!showAdd || !mountRef.current) return;
      let cancelled = false;
      let card = null;
      ensureStripe().then((stripe) => {
        if (cancelled || !stripe || !mountRef.current) return;
        const elements = stripe.elements();
        card = elements.create("card", {
          style: { base: { fontSize: "15px", fontFamily: "Inter, sans-serif", color: "#292524", "::placeholder": { color: "#a8a29e" } }, invalid: { color: "#dc2626" } }
        });
        card.mount(mountRef.current);
        card.on("change", (ev) => {
          setCardComplete(ev.complete);
          setCardError(ev.error ? ev.error.message : "");
        });
        cardElRef.current = card;
      });
      return () => {
        cancelled = true;
        if (card) card.destroy();
        cardElRef.current = null;
        setCardComplete(false);
      };
    }, [showAdd]);
    const saveNewCard = async () => {
      if (!stripeInstance || !cardElRef.current || !cardComplete) return;
      setSavingCard(true);
      setCardError("");
      setMsg("");
      try {
        const r = await fetch(API + "/api/customer/payment-methods/setup-intent", {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" }
        });
        const data = await r.json();
        if (!data.client_secret) throw new Error(data.error || "Could not start card setup");
        const result = await stripeInstance.confirmCardSetup(data.client_secret, {
          payment_method: {
            card: cardElRef.current,
            billing_details: { name: ((customer.first_name || "") + " " + (customer.last_name || "")).trim(), email: customer.email }
          }
        });
        if (result.error) throw new Error(result.error.message);
        setShowAdd(false);
        setMsg("Card saved.");
        loadCards();
      } catch (e) {
        setCardError(e.message || "Failed to save card");
      }
      setSavingCard(false);
    };
    const removeCard = async (pmId) => {
      if (!confirm("Remove this card?")) return;
      setRemoving(pmId);
      try {
        const r = await fetch(API + "/api/customer/payment-methods/" + pmId, { method: "DELETE", headers: authHeaders });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || "Failed to remove card");
        }
        setCards((prev) => (prev || []).filter((c) => c.id !== pmId));
      } catch (e) {
        alert(e.message || "Failed to remove card");
      }
      setRemoving(null);
    };
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginBottom: "1rem", paddingTop: "1.5rem", borderTop: "1px solid var(--stone-200)" } }, "Payment Methods"), msg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, msg), cards === null ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading saved cards...") : cards.length === 0 && !showAdd ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem", marginBottom: "1rem" } }, "No saved cards yet. Add one here \u2014 or check \u201CSave card\u201D at checkout \u2014 for faster ordering.") : null, (cards || []).map((c) => /* @__PURE__ */ React.createElement("div", { key: c.id, style: { display: "flex", alignItems: "center", gap: "0.75rem", border: "1px solid var(--stone-200)", padding: "0.75rem 1rem", marginBottom: "0.5rem" } }, /* @__PURE__ */ React.createElement("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "var(--stone-500)", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "4", width: "22", height: "16", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "10", x2: "23", y2: "10" })), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", fontWeight: 500, color: "var(--stone-800)", textTransform: "capitalize" } }, c.brand), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", color: "var(--stone-600)", letterSpacing: "0.08em" } }, "\u2022\u2022\u2022\u2022 " + c.last4), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, "Exp ", String(c.exp_month).padStart(2, "0"), "/", String(c.exp_year).slice(-2)), /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => removeCard(c.id),
        disabled: removing === c.id,
        style: { marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "0.8125rem", color: "#b91c1c", fontFamily: "Inter, sans-serif" }
      },
      removing === c.id ? "Removing..." : "Remove"
    ))), showAdd ? /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--stone-200)", padding: "1rem", marginTop: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "0.35rem", fontSize: "0.8125rem", fontWeight: 500, color: "var(--stone-800)" } }, "Card details"), /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--stone-200)", padding: "0.75rem", background: "#fff" } }, /* @__PURE__ */ React.createElement("div", { ref: mountRef })), cardError && /* @__PURE__ */ React.createElement("div", { style: { color: "#b91c1c", fontSize: "0.8125rem", marginTop: "0.5rem" } }, cardError), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", margin: "0.75rem 0" } }, "Stored securely with Stripe \u2014 your card number never touches our servers."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveNewCard, disabled: !cardComplete || savingCard }, savingCard ? "Saving..." : "Save Card"), /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => {
          setShowAdd(false);
          setCardError("");
        },
        disabled: savingCard,
        style: { background: "none", border: "1px solid var(--stone-300)", padding: "0 1.25rem", cursor: "pointer", fontSize: "0.875rem", fontFamily: "Inter, sans-serif", color: "var(--stone-700)" }
      },
      "Cancel"
    ))) : /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      setMsg("");
      setShowAdd(true);
    }, style: { marginTop: "0.25rem", marginBottom: "1rem" } }, "+ Add a Card"));
  }
  function AccountPage({ customer, customerToken, setCustomer, goBrowse }) {
    const [tab, setTab] = useState("orders");
    const [orders, setOrders] = useState([]);
    const [expandedOrder, setExpandedOrder] = useState(null);
    const [orderDetail, setOrderDetail] = useState(null);
    const [loadingOrders, setLoadingOrders] = useState(true);
    const [sampleRequests, setSampleRequests] = useState([]);
    const [loadingSamples, setLoadingSamples] = useState(true);
    const [expandedSample, setExpandedSample] = useState(null);
    const [addItemsTo, setAddItemsTo] = useState(null);
    const [sampleSearch, setSampleSearch] = useState("");
    const [sampleSearchResults, setSampleSearchResults] = useState([]);
    const [searchingProducts, setSearchingProducts] = useState(false);
    const [addingSampleItem, setAddingSampleItem] = useState(null);
    const [quotes, setQuotes] = useState([]);
    const [loadingQuotes, setLoadingQuotes] = useState(true);
    const [expandedQuote, setExpandedQuote] = useState(null);
    const [quoteDetail, setQuoteDetail] = useState(null);
    const [visits, setVisits] = useState([]);
    const [loadingVisits, setLoadingVisits] = useState(true);
    const [expandedVisit, setExpandedVisit] = useState(null);
    const [visitDetail, setVisitDetail] = useState(null);
    const [firstName, setFirstName] = useState(customer.first_name || "");
    const [lastName, setLastName] = useState(customer.last_name || "");
    const [phone, setPhone] = useState(customer.phone || "");
    const [addressLine1, setAddressLine1] = useState(customer.address_line1 || "");
    const [addressLine2, setAddressLine2] = useState(customer.address_line2 || "");
    const [city, setCity] = useState(customer.city || "");
    const [addrState, setAddrState] = useState(customer.state || "");
    const [zip, setZip] = useState(customer.zip || "");
    const [profileMsg, setProfileMsg] = useState("");
    const [profileError, setProfileError] = useState("");
    const [saving, setSaving] = useState(false);
    const [currentPw, setCurrentPw] = useState("");
    const [newPw, setNewPw] = useState("");
    const [confirmPw, setConfirmPw] = useState("");
    const [pwMsg, setPwMsg] = useState("");
    const [pwError, setPwError] = useState("");
    const [pwSaving, setPwSaving] = useState(false);
    const headers = { "X-Customer-Token": customerToken, "Content-Type": "application/json" };
    const authHeaders = { "X-Customer-Token": customerToken };
    useEffect(() => {
      fetch(API + "/api/customer/orders", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setOrders(data.orders || []);
        setLoadingOrders(false);
      }).catch(() => setLoadingOrders(false));
      fetch(API + "/api/customer/sample-requests", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setSampleRequests(data.sample_requests || []);
        setLoadingSamples(false);
      }).catch(() => setLoadingSamples(false));
      fetch(API + "/api/customer/quotes", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setQuotes(data.quotes || []);
        setLoadingQuotes(false);
      }).catch(() => setLoadingQuotes(false));
      fetch(API + "/api/customer/visits", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setVisits(data.visits || []);
        setLoadingVisits(false);
      }).catch(() => setLoadingVisits(false));
    }, []);
    const refreshSamples = () => {
      fetch(API + "/api/customer/sample-requests", { headers: authHeaders }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setSampleRequests(data.sample_requests || [])).catch(() => {
      });
    };
    const searchProducts = async (q) => {
      if (!q || q.length < 2) {
        setSampleSearchResults([]);
        return;
      }
      setSearchingProducts(true);
      try {
        const resp = await fetch(API + "/api/storefront/skus?search=" + encodeURIComponent(q) + "&limit=8");
        const data = await resp.json();
        setSampleSearchResults(data.skus || []);
      } catch (e) {
        setSampleSearchResults([]);
      }
      setSearchingProducts(false);
    };
    const addSampleItem = async (srId, productId, skuId) => {
      setAddingSampleItem(skuId || productId);
      try {
        const resp = await fetch(API + "/api/customer/sample-requests/" + srId + "/add-items", {
          method: "POST",
          headers,
          body: JSON.stringify({ items: [{ product_id: productId, sku_id: skuId }] })
        });
        if (resp.ok) {
          refreshSamples();
          setSampleSearch("");
          setSampleSearchResults([]);
        } else {
          const data = await resp.json();
          alert(data.error || "Failed to add sample");
        }
      } catch (e) {
        alert("Failed to add sample");
      }
      setAddingSampleItem(null);
    };
    const viewOrderDetail = async (orderId) => {
      if (expandedOrder === orderId) {
        setExpandedOrder(null);
        setOrderDetail(null);
        return;
      }
      setExpandedOrder(orderId);
      try {
        const resp = await fetch(API + "/api/customer/orders/" + orderId, { headers: authHeaders });
        const data = await resp.json();
        setOrderDetail(data);
      } catch (e) {
        setOrderDetail(null);
      }
    };
    const viewQuoteDetail = async (quoteId) => {
      if (expandedQuote === quoteId) {
        setExpandedQuote(null);
        setQuoteDetail(null);
        return;
      }
      setExpandedQuote(quoteId);
      try {
        const resp = await fetch(API + "/api/customer/quotes/" + quoteId, { headers: authHeaders });
        const data = await resp.json();
        setQuoteDetail(data);
      } catch (e) {
        setQuoteDetail(null);
      }
    };
    const viewVisitDetail = async (visitId) => {
      if (expandedVisit === visitId) {
        setExpandedVisit(null);
        setVisitDetail(null);
        return;
      }
      setExpandedVisit(visitId);
      try {
        const resp = await fetch(API + "/api/customer/visits/" + visitId, { headers: authHeaders });
        const data = await resp.json();
        setVisitDetail(data);
      } catch (e) {
        setVisitDetail(null);
      }
    };
    const quoteStatusBadge = (status, expiresAt) => {
      const colors = {
        sent: { bg: "#dbeafe", text: "#1e40af", label: "Sent" },
        converted: { bg: "#dcfce7", text: "#166534", label: "Converted" },
        expired: { bg: "#fef2f2", text: "#991b1b", label: "Expired" }
      };
      const isExpired = status === "sent" && expiresAt && new Date(expiresAt) < /* @__PURE__ */ new Date();
      const c = isExpired ? colors.expired : colors[status] || colors.sent;
      return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.2rem 0.6rem", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", background: c.bg, color: c.text, borderRadius: "3px" } }, isExpired ? "Expired" : c.label);
    };
    const saveProfile = async () => {
      setSaving(true);
      setProfileMsg("");
      setProfileError("");
      try {
        const resp = await fetch(API + "/api/customer/profile", {
          method: "PUT",
          headers,
          body: JSON.stringify({ first_name: firstName, last_name: lastName, phone, address_line1: addressLine1, address_line2: addressLine2, city, state: addrState, zip })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setProfileError(data.error);
          setSaving(false);
          return;
        }
        setCustomer(data.customer);
        setProfileMsg("Profile updated successfully.");
      } catch (e) {
        setProfileError("Failed to save.");
      }
      setSaving(false);
    };
    const changePassword = async () => {
      setPwSaving(true);
      setPwMsg("");
      setPwError("");
      if (newPw !== confirmPw) {
        setPwError("Passwords do not match.");
        setPwSaving(false);
        return;
      }
      try {
        const resp = await fetch(API + "/api/customer/password", {
          method: "PUT",
          headers,
          body: JSON.stringify({ current_password: currentPw, new_password: newPw })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setPwError(data.error);
          setPwSaving(false);
          return;
        }
        setPwMsg("Password updated successfully.");
        setCurrentPw("");
        setNewPw("");
        setConfirmPw("");
      } catch (e) {
        setPwError("Failed to update password.");
      }
      setPwSaving(false);
    };
    const formatPhone = (val) => {
      const digits = val.replace(/\D/g, "").slice(0, 10);
      if (digits.length === 0) return "";
      if (digits.length <= 3) return "(" + digits;
      if (digits.length <= 6) return "(" + digits.slice(0, 3) + ") " + digits.slice(3);
      return "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
    };
    const statusBadge = (status) => {
      const colors = {
        pending: { bg: "#fef3c7", text: "#92400e" },
        confirmed: { bg: "#dbeafe", text: "#1e40af" },
        ready_for_pickup: { bg: "#f0fdf4", text: "#166534" },
        shipped: { bg: "#e0e7ff", text: "#3730a3" },
        delivered: { bg: "#dcfce7", text: "#166534" },
        cancelled: { bg: "#fef2f2", text: "#991b1b" }
      };
      const c = colors[status] || colors.pending;
      const label = status === "ready_for_pickup" ? "ready for pickup" : status;
      return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.2rem 0.6rem", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", background: c.bg, color: c.text, borderRadius: "3px" } }, label);
    };
    const US_STATES = [
      "AL",
      "AK",
      "AZ",
      "AR",
      "CA",
      "CO",
      "CT",
      "DE",
      "FL",
      "GA",
      "HI",
      "ID",
      "IL",
      "IN",
      "IA",
      "KS",
      "KY",
      "LA",
      "ME",
      "MD",
      "MA",
      "MI",
      "MN",
      "MS",
      "MO",
      "MT",
      "NE",
      "NV",
      "NH",
      "NJ",
      "NM",
      "NY",
      "NC",
      "ND",
      "OH",
      "OK",
      "OR",
      "PA",
      "RI",
      "SC",
      "SD",
      "TN",
      "TX",
      "UT",
      "VT",
      "VA",
      "WA",
      "WV",
      "WI",
      "WY",
      "DC"
    ];
    const inputStyle = {
      width: "100%",
      padding: "0.65rem 0.75rem",
      border: "1px solid var(--stone-200)",
      fontSize: "0.875rem",
      fontFamily: "Inter, sans-serif",
      outline: "none"
    };
    const labelStyle = { display: "block", marginBottom: "0.35rem", fontSize: "0.8125rem", fontWeight: 500, color: "var(--stone-800)" };
    const fieldStyle = { marginBottom: "1rem" };
    return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 900, margin: "3rem auto", padding: "0 1.5rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: "2rem", fontWeight: 400, marginBottom: "0.5rem" } }, "My Account"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.875rem", marginBottom: "2rem" } }, "Welcome back, ", customer.first_name), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "2rem", borderBottom: "1px solid var(--stone-200)", marginBottom: "2rem" } }, ["orders", "quotes", "samples", "visits", "profile"].map((t) => {
      const labels = { orders: "Order History", quotes: "Quotes", samples: "My Samples", visits: "Visits", profile: "Profile" };
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: t,
          onClick: () => setTab(t),
          style: {
            background: "none",
            border: "none",
            padding: "0.75rem 0",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
            fontFamily: "Inter, sans-serif",
            color: tab === t ? "var(--stone-900)" : "var(--stone-500)",
            borderBottom: tab === t ? "2px solid var(--gold)" : "2px solid transparent",
            marginBottom: "-1px"
          }
        },
        labels[t]
      );
    })), tab === "orders" && /* @__PURE__ */ React.createElement("div", null, loadingOrders ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading orders...") : orders.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "3rem 0" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", marginBottom: "1rem" } }, "No orders yet."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Start Shopping")) : /* @__PURE__ */ React.createElement("div", null, orders.map((order) => /* @__PURE__ */ React.createElement("div", { key: order.id, style: { border: "1px solid var(--stone-200)", marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: () => viewOrderDetail(order.id),
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.25rem",
          cursor: "pointer",
          background: expandedOrder === order.id ? "var(--stone-50)" : "#fff"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "1.5rem", flex: 1, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, order.order_number), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.8125rem" } }, new Date(order.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), statusBadge(order.status), parseFloat(order.total || 0) > parseFloat(order.amount_paid || 0) + 0.01 && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "2px 8px", fontSize: "0.6875rem", fontWeight: 600, background: "#fef3c7", color: "#92400e" } }, "Balance Due"), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, "$", parseFloat(order.total).toFixed(2))),
      /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: {
        width: 16,
        height: 16,
        transform: expandedOrder === order.id ? "rotate(180deg)" : "rotate(0)",
        transition: "transform 0.2s"
      } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))
    ), expandedOrder === order.id && orderDetail && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, orderDetail.order.tracking_number && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Tracking: ", orderDetail.order.shipping_carrier && /* @__PURE__ */ React.createElement("strong", null, orderDetail.order.shipping_carrier, " "), orderDetail.order.tracking_number, orderDetail.order.shipped_at && /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "0.5rem" } }, "(Shipped ", new Date(orderDetail.order.shipped_at).toLocaleDateString(), ")")), orderDetail.order.delivery_method === "pickup" && orderDetail.fulfillment_summary && orderDetail.fulfillment_summary.total > 0 && ["confirmed", "shipped", "delivered"].includes(orderDetail.order.status) && (() => {
      const { total, received } = orderDetail.fulfillment_summary;
      const allReady = received >= total;
      return /* @__PURE__ */ React.createElement("div", { style: {
        background: allReady ? "#f0fdf4" : "#fffbeb",
        border: "1px solid " + (allReady ? "#bbf7d0" : "#fde68a"),
        padding: "0.75rem 1rem",
        marginBottom: "1rem",
        fontSize: "0.8125rem",
        color: allReady ? "#166534" : "#92400e",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem"
      } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("strong", null, allReady ? "All items ready for pickup!" : `${received} of ${total} items ready for pickup`), !allReady && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.8 } }, "Remaining items are still being received from suppliers")), /* @__PURE__ */ React.createElement("div", { style: { width: 48, height: 48, borderRadius: "50%", background: allReady ? "#22c55e" : "#f59e0b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.8125rem", flexShrink: 0 } }, received, "/", total));
    })(), orderDetail.order.delivery_method !== "pickup" && orderDetail.fulfillment_summary && orderDetail.fulfillment_summary.total > 0 && orderDetail.fulfillment_summary.received > 0 && orderDetail.fulfillment_summary.received < orderDetail.fulfillment_summary.total && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Your order is being prepared \u2014 ", orderDetail.fulfillment_summary.received, " of ", orderDetail.fulfillment_summary.total, " items received from suppliers"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0", marginBottom: "1.25rem", fontSize: "0.75rem" } }, (() => {
      const isPickupOrder = orderDetail.order.delivery_method === "pickup";
      const steps = isPickupOrder ? ["pending", "confirmed", "ready_for_pickup", "delivered"] : ["pending", "confirmed", "shipped", "delivered"];
      const stepLabels = isPickupOrder ? { pending: "pending", confirmed: "confirmed", ready_for_pickup: "ready", delivered: "picked up" } : { pending: "pending", confirmed: "confirmed", shipped: "shipped", delivered: "delivered" };
      const currentIdx = steps.indexOf(orderDetail.order.status);
      return steps.map((s, i) => {
        const isActive = i <= currentIdx;
        return /* @__PURE__ */ React.createElement("div", { key: s, style: { flex: 1, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: {
          width: 24,
          height: 24,
          borderRadius: "50%",
          margin: "0 auto 0.35rem",
          background: isActive ? "var(--gold)" : "var(--stone-200)",
          color: isActive ? "#fff" : "var(--stone-500)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.7rem",
          fontWeight: 600
        } }, i + 1), /* @__PURE__ */ React.createElement("span", { style: { color: isActive ? "var(--stone-800)" : "var(--stone-400)", textTransform: "capitalize" } }, stepLabels[s]));
      });
    })()), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Items"), orderDetail.items.map((item) => {
      const fStatus = item.fulfillment_status;
      const isPickup = orderDetail.order.delivery_method === "pickup";
      const badgeMap = {
        "received": { label: isPickup ? "Ready" : "Received", bg: "#f0fdf4", color: "#166534" },
        "shipped": { label: "In Transit", bg: "#dbeafe", color: "#1e40af" },
        "ordered": { label: "Ordered", bg: "#fffbeb", color: "#92400e" },
        "pending": { label: "Processing", bg: "var(--stone-100)", color: "var(--stone-500)" }
      };
      const badge = !item.is_sample ? badgeMap[fStatus] || badgeMap["pending"] : null;
      return /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.4rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "0.5rem", flex: 1 } }, item.product_name || "Product", " ", item.is_sample ? "(Sample)" : item.sell_by === "unit" ? `x${item.num_boxes}` : `x${item.num_boxes} box${item.num_boxes !== 1 ? "es" : ""}`, badge && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "1px 6px", fontSize: "0.6875rem", fontWeight: 600, background: badge.bg, color: badge.color, borderRadius: "3px", whiteSpace: "nowrap" } }, badge.label)), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, "$", parseFloat(item.subtotal || 0).toFixed(2)));
    })), orderDetail.balance && orderDetail.balance.balance_status === "credit" && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "You have a credit of ", /* @__PURE__ */ React.createElement("strong", null, "$", Math.abs(orderDetail.balance.balance).toFixed(2)), " on this order."), orderDetail.balance && orderDetail.balance.balance_status === "balance_due" && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef3c7", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#92400e" } }, "Balance due: ", /* @__PURE__ */ React.createElement("strong", null, "$", orderDetail.balance.balance.toFixed(2)), " \u2014 check your email for a payment link."), orderDetail.order.shipping_address_line1 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("strong", null, "Ships to:"), " ", orderDetail.order.shipping_address_line1, orderDetail.order.shipping_address_line2 && ", " + orderDetail.order.shipping_address_line2, ", ", orderDetail.order.shipping_city, ", ", orderDetail.order.shipping_state, " ", orderDetail.order.shipping_zip)))))), tab === "quotes" && /* @__PURE__ */ React.createElement("div", null, loadingQuotes ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading quotes...") : quotes.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "3rem 0" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 48, height: 48, color: "var(--stone-300)", margin: "0 auto 1rem" } }, /* @__PURE__ */ React.createElement("path", { d: "M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" })), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", marginBottom: "1rem" } }, "No quotes yet."), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.8125rem" } }, "Quotes from our sales team will appear here.")) : /* @__PURE__ */ React.createElement("div", null, quotes.map((q) => /* @__PURE__ */ React.createElement("div", { key: q.id, style: { border: "1px solid var(--stone-200)", marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: () => viewQuoteDetail(q.id),
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.25rem",
          cursor: "pointer",
          background: expandedQuote === q.id ? "var(--stone-50)" : "#fff"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "1.25rem", flex: 1, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, q.quote_number), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.8125rem" } }, new Date(q.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), quoteStatusBadge(q.status, q.expires_at), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, q.item_count, " item", q.item_count !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, "$", parseFloat(q.total || 0).toFixed(2))),
      /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: {
        width: 16,
        height: 16,
        transform: expandedQuote === q.id ? "rotate(180deg)" : "rotate(0)",
        transition: "transform 0.2s"
      } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))
    ), expandedQuote === q.id && quoteDetail && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, q.converted_order_id && /* @__PURE__ */ React.createElement("div", { style: { background: "#dcfce7", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#166534" } }, "This quote has been converted to an order."), q.expires_at && q.status === "sent" && new Date(q.expires_at) > /* @__PURE__ */ new Date() && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Valid until ", new Date(q.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Items"), quoteDetail.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.4rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, item.product_name || "Product"), item.collection && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", marginLeft: "0.5rem" } }, item.collection), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", marginLeft: "0.5rem" } }, item.sell_by === "unit" ? `x${item.num_boxes}` : `x${item.num_boxes} box${item.num_boxes !== 1 ? "es" : ""}`), item.is_sample && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-400)", marginLeft: "0.5rem" } }, "(Sample)")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.75rem", marginRight: "0.75rem" } }, "$", parseFloat(item.unit_price || 0).toFixed(2), item.sell_by === "unit" ? "/ea" : "/sqft"), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, "$", parseFloat(item.subtotal || 0).toFixed(2)))))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: "1.5rem", fontSize: "0.8125rem", paddingTop: "0.5rem" } }, parseFloat(q.shipping || 0) > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-600)" } }, "Shipping: $", parseFloat(q.shipping).toFixed(2)), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 600 } }, "Total: $", parseFloat(q.total || 0).toFixed(2))), q.notes && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1rem", fontSize: "0.8125rem", color: "var(--stone-600)", fontStyle: "italic" } }, "Note: ", q.notes)))))), tab === "samples" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse, style: { fontSize: "0.8125rem", padding: "0.5rem 1.25rem" } }, "Browse Products for Samples"), sampleRequests.filter((sr) => sr.status === "requested").length > 0 && /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", fontSize: "0.8125rem", color: "var(--stone-600)", gap: "0.35rem" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#f59e0b" } }), sampleRequests.filter((sr) => sr.status === "requested").length, " open request", sampleRequests.filter((sr) => sr.status === "requested").length !== 1 ? "s" : "")), loadingSamples ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading samples...") : sampleRequests.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "3rem 0" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 48, height: 48, color: "var(--stone-300)", margin: "0 auto 1rem" } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M3 9h18M9 21V9" })), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", marginBottom: "1rem" } }, "No sample requests yet."), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.8125rem", marginBottom: "1rem" } }, 'Use the "Request Free Sample" button on any product page, or contact our team for assistance.'), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Browse Products")) : /* @__PURE__ */ React.createElement("div", null, sampleRequests.map((sr) => {
      const isOpen = sr.status === "requested";
      const isExpanded = expandedSample === sr.id;
      const isAdding = addItemsTo === sr.id;
      const sColors = {
        requested: { bg: "#fef3c7", text: "#92400e", label: "Open" },
        shipped: { bg: "#dbeafe", text: "#1e40af", label: "Shipped" },
        delivered: { bg: "#dcfce7", text: "#166534", label: "Delivered" },
        cancelled: { bg: "#fef2f2", text: "#991b1b", label: "Cancelled" }
      };
      const sc = sColors[sr.status] || sColors.requested;
      return /* @__PURE__ */ React.createElement("div", { key: sr.id, style: { border: "1px solid var(--stone-200)", marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(
        "div",
        {
          onClick: () => setExpandedSample(isExpanded ? null : sr.id),
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.25rem", cursor: "pointer", background: isExpanded ? "var(--stone-50)" : "#fff" }
        },
        /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "1.25rem", flex: 1, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, sr.request_number), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.8125rem" } }, new Date(sr.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.2rem 0.6rem", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", background: sc.bg, color: sc.text, borderRadius: "3px" } }, sc.label), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, (sr.items || []).length, " sample", (sr.items || []).length !== 1 ? "s" : "")),
        /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16, transform: isExpanded ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))
      ), isExpanded && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, sr.tracking_number && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Tracking: ", sr.tracking_number, sr.shipped_at && /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "0.5rem" } }, "(Shipped ", new Date(sr.shipped_at).toLocaleDateString(), ")")), sr.delivery_method === "pickup" && sr.status === "shipped" && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#166534" } }, "Your samples are ready for pickup at our showroom."), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Samples"), (sr.items || []).map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image, 100), alt: item.product_name, style: { width: 40, height: 40, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection), item.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.variant_name)), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.75rem", color: "var(--stone-400)", textTransform: "uppercase" } }, "Free")))), isOpen && (sr.items || []).length < 5 && /* @__PURE__ */ React.createElement("div", { style: { background: "#fff", border: "1px solid var(--stone-200)", padding: "1rem", marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.75rem" } }, "Add Samples to This Request"), /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "text",
          placeholder: "Search products to add...",
          value: isAdding ? sampleSearch : "",
          onFocus: () => setAddItemsTo(sr.id),
          onChange: (e) => {
            setAddItemsTo(sr.id);
            setSampleSearch(e.target.value);
            searchProducts(e.target.value);
          },
          style: { width: "100%", padding: "0.5rem 0.75rem", border: "1px solid var(--stone-200)", fontSize: "0.8125rem", fontFamily: "Inter, sans-serif", outline: "none", marginBottom: "0.5rem" }
        }
      ), isAdding && searchingProducts && /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-400)" } }, "Searching..."), isAdding && sampleSearchResults.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--stone-200)", maxHeight: 200, overflowY: "auto" } }, sampleSearchResults.map((sku) => {
        const alreadyAdded = (sr.items || []).some((i) => i.product_id === sku.product_id);
        return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, style: { display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 100), alt: "", style: { width: 32, height: 32, objectFit: "cover" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, sku.product_name || sku.collection), sku.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, sku.variant_name)), alreadyAdded ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.6875rem", color: "var(--stone-400)" } }, "Added") : /* @__PURE__ */ React.createElement(
          "button",
          {
            onClick: () => addSampleItem(sr.id, sku.product_id, sku.sku_id),
            disabled: addingSampleItem === (sku.sku_id || sku.product_id),
            style: { background: "var(--stone-900)", color: "#fff", border: "none", padding: "0.25rem 0.75rem", fontSize: "0.75rem", cursor: "pointer", fontFamily: "Inter, sans-serif" }
          },
          addingSampleItem === (sku.sku_id || sku.product_id) ? "..." : "+ Add"
        ));
      })), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.6875rem", color: "var(--stone-400)", marginTop: "0.5rem" } }, 5 - (sr.items || []).length, " more sample", 5 - (sr.items || []).length !== 1 ? "s" : "", " can be added")), sr.delivery_method && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-600)", marginTop: "0.75rem" } }, /* @__PURE__ */ React.createElement("strong", null, "Delivery:"), " ", sr.delivery_method === "pickup" ? "Showroom Pickup" : "Shipping")));
    }))), tab === "visits" && /* @__PURE__ */ React.createElement("div", null, loadingVisits ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading visits...") : visits.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "3rem 0" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 48, height: 48, color: "var(--stone-300)", margin: "0 auto 1rem" } }, /* @__PURE__ */ React.createElement("path", { d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" })), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", marginBottom: "1rem" } }, "No showroom visits yet."), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.8125rem" } }, "After visiting our showroom, your product recommendations will appear here.")) : /* @__PURE__ */ React.createElement("div", null, visits.map((v) => /* @__PURE__ */ React.createElement("div", { key: v.id, style: { border: "1px solid var(--stone-200)", marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(
      "div",
      {
        onClick: () => viewVisitDetail(v.id),
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.25rem",
          cursor: "pointer",
          background: expandedVisit === v.id ? "var(--stone-50)" : "#fff"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "1.25rem", flex: 1, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, fontSize: "0.875rem" } }, new Date(v.sent_at || v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, v.item_count, " product", v.item_count !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.2rem 0.6rem", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", background: "#dbeafe", color: "#1e40af", borderRadius: "3px" } }, "Showroom Visit")),
      /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: {
        width: 16,
        height: 16,
        transform: expandedVisit === v.id ? "rotate(180deg)" : "rotate(0)",
        transition: "transform 0.2s"
      } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))
    ), expandedVisit === v.id && visitDetail && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, v.message && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af", fontStyle: "italic" } }, '"', v.message, '"'), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Recommended Products"), visitDetail.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image, 100), alt: item.product_name, style: { width: 48, height: 48, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection), item.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.variant_name)), skuListPrice(item) && /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, whiteSpace: "nowrap" } }, "$", displayPrice(item, skuListPrice(item)).toFixed(2), priceSuffix(item)), item.rep_note && /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.75rem", color: "var(--stone-500)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: item.rep_note }, item.rep_note))))))))), tab === "profile" && /* @__PURE__ */ React.createElement("div", null, profileMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileMsg), profileError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileError), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "First Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: firstName, onChange: (e) => setFirstName(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Last Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: lastName, onChange: (e) => setLastName(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Email"), /* @__PURE__ */ React.createElement("input", { style: { ...inputStyle, background: "var(--stone-100)", color: "var(--stone-500)" }, value: customer.email, readOnly: true })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Phone"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "tel", value: phone, onChange: (e) => setPhone(formatPhone(e.target.value)), placeholder: "(555) 123-4567" })), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginTop: "1.5rem", marginBottom: "1rem" } }, "Saved Address"), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 1"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine1, onChange: (e) => setAddressLine1(e.target.value), placeholder: "123 Main Street" })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 2"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine2, onChange: (e) => setAddressLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "City"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: city, onChange: (e) => setCity(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "State"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, padding: "0.65rem 0.5rem" }, value: addrState, onChange: (e) => setAddrState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "ZIP"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: zip, onChange: (e) => setZip(e.target.value) }))), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveProfile, disabled: saving, style: { marginBottom: "2.5rem" } }, saving ? "Saving..." : "Save Changes"), /* @__PURE__ */ React.createElement(PaymentMethodsSection, { customerToken, customer }), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginBottom: "1rem", paddingTop: "1.5rem", borderTop: "1px solid var(--stone-200)" } }, "Change Password"), pwMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwMsg), pwError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwError), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Current Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: currentPw, onChange: (e) => setCurrentPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: newPw, onChange: (e) => setNewPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Confirm New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: confirmPw, onChange: (e) => setConfirmPw(e.target.value) }))), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginBottom: "1rem" } }, "8+ characters, 1 uppercase letter, 1 number"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: changePassword, disabled: pwSaving }, pwSaving ? "Updating..." : "Update Password")));
  }
  function WishlistPage({ wishlist, toggleWishlist: toggleWishlist2, onSkuClick, goBrowse, recentlyViewed, goHome }) {
    const [skus, setSkus] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      if (wishlist.length === 0) {
        setSkus([]);
        setLoading(false);
        return;
      }
      const skuIds = wishlist.join(",");
      fetch(API + "/api/storefront/skus?sku_ids=" + encodeURIComponent(skuIds) + "&limit=" + wishlist.length).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        const all = data.skus || [];
        const skuMap = /* @__PURE__ */ new Map();
        all.forEach((sku) => skuMap.set(sku.sku_id, sku));
        const wishlisted = wishlist.map((id) => skuMap.get(id)).filter(Boolean);
        setSkus(wishlisted);
        setLoading(false);
      }).catch(() => setLoading(false));
    }, [wishlist]);
    return /* @__PURE__ */ React.createElement("div", { className: "wishlist-page" }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: [
      { label: "Home", onClick: goHome },
      { label: "Wishlist" }
    ] }), /* @__PURE__ */ React.createElement("h1", null, "Wishlist ", /* @__PURE__ */ React.createElement("span", { style: { fontSize: "1.25rem", color: "var(--stone-600)", fontWeight: 300 } }, "(", wishlist.length, ")")), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 4 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "wishlist-empty" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 56, height: 56, color: "var(--stone-300)", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.75rem", fontWeight: 300, marginBottom: "0.5rem" } }, "Your Wishlist is Empty"), /* @__PURE__ */ React.createElement("p", null, "Save your favorite products by clicking the heart icon while you browse."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse, style: { marginTop: "0.5rem" } }, "Browse Products"), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem", textAlign: "left" } }, /* @__PURE__ */ React.createElement("h3", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem", textAlign: "center" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, rv.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(rv.primary_image, 400), alt: rv.product_name, loading: "lazy" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(rv)), skuListPrice(rv) && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(rv, skuListPrice(rv)).toFixed(2), priceSuffix(rv))))))) : /* @__PURE__ */ React.createElement("div", { className: "sku-grid" }, skus.map((sku) => /* @__PURE__ */ React.createElement(
      SkuCard,
      {
        key: sku.sku_id,
        sku,
        onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection),
        isWished: true,
        onToggleWishlist: () => toggleWishlist2(sku.sku_id)
      }
    ))));
  }
  function TradeDashboard({ tradeCustomer, tradeToken, addToCart, goBrowse, setTradeCustomer, handleTradeLogout, goBulkOrder, showToast }) {
    const [tab, setTab] = useState("overview");
    const [dashData, setDashData] = useState(null);
    const [orders, setOrders] = useState([]);
    const [projects, setProjects] = useState([]);
    const [favorites, setFavorites] = useState([]);
    const [account, setAccount] = useState(null);
    const [loading, setLoading] = useState(true);
    const [membership, setMembership] = useState(null);
    const [rep, setRep] = useState(null);
    const [showProjectForm, setShowProjectForm] = useState(false);
    const [projectForm, setProjectForm] = useState({ name: "", client_name: "", address: "", notes: "" });
    const [editingProject, setEditingProject] = useState(null);
    const [showFavForm, setShowFavForm] = useState(false);
    const [favName, setFavName] = useState("");
    const [expandedOrder, setExpandedOrder] = useState(null);
    const [quotes, setQuotes] = useState([]);
    const [expandedQuote, setExpandedQuote] = useState(null);
    const [quoteDetail, setQuoteDetail] = useState(null);
    const [visits, setVisits] = useState([]);
    const [expandedVisit, setExpandedVisit] = useState(null);
    const [visitDetail, setVisitDetail] = useState(null);
    const headers = { "X-Trade-Token": tradeToken, "Content-Type": "application/json" };
    const authHeaders = { "X-Trade-Token": tradeToken };
    const loadTab = (t) => {
      setLoading(true);
      if (t === "overview") {
        fetch(API + "/api/trade/dashboard", { headers: authHeaders }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => {
          setDashData(d);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "orders") {
        Promise.all([
          fetch(API + "/api/trade/orders", { headers: authHeaders }).then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }),
          fetch(API + "/api/trade/projects", { headers: authHeaders }).then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).catch(() => ({ projects: [] }))
        ]).then(([od, pd]) => {
          setOrders(od.orders || []);
          setProjects(pd.projects || []);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "projects") {
        fetch(API + "/api/trade/projects", { headers: authHeaders }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => {
          setProjects(d.projects || []);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "favorites") {
        fetch(API + "/api/trade/favorites", { headers: authHeaders }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => {
          setFavorites(d.collections || []);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "quotes") {
        fetch(API + "/api/trade/quotes", { headers: authHeaders }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => {
          setQuotes(d.quotes || []);
          setExpandedQuote(null);
          setQuoteDetail(null);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "visits") {
        fetch(API + "/api/trade/visits", { headers: authHeaders }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        }).then((d) => {
          setVisits(d.visits || []);
          setExpandedVisit(null);
          setVisitDetail(null);
          setLoading(false);
        }).catch(() => setLoading(false));
      } else if (t === "account") {
        Promise.all([
          fetch(API + "/api/trade/account", { headers: authHeaders }).then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }),
          fetch(API + "/api/trade/membership", { headers: authHeaders }).then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).catch(() => ({})),
          fetch(API + "/api/trade/my-rep", { headers: authHeaders }).then((r) => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          }).catch(() => ({}))
        ]).then(([acc, mem, rp]) => {
          setAccount(acc.customer || acc);
          setMembership(mem);
          setRep(rp.rep || null);
          setLoading(false);
        }).catch(() => setLoading(false));
      }
    };
    useEffect(() => {
      loadTab(tab);
    }, [tab]);
    const saveProject = async () => {
      const method = editingProject ? "PUT" : "POST";
      const url = editingProject ? API + "/api/trade/projects/" + editingProject : API + "/api/trade/projects";
      await fetch(url, { method, headers, body: JSON.stringify(projectForm) });
      setShowProjectForm(false);
      setEditingProject(null);
      setProjectForm({ name: "", client_name: "", address: "", notes: "" });
      loadTab("projects");
    };
    const createCollection = async () => {
      if (!favName.trim()) return;
      await fetch(API + "/api/trade/favorites", { method: "POST", headers, body: JSON.stringify({ collection_name: favName }) });
      setShowFavForm(false);
      setFavName("");
      loadTab("favorites");
    };
    const cancelMembership = async () => {
      if (!confirm("Cancel your trade membership? You will retain access until your current period ends.")) return;
      await fetch(API + "/api/trade/cancel-membership", { method: "POST", headers: authHeaders });
      loadTab("account");
    };
    const deleteProject = async (id) => {
      if (!confirm("Delete this project?")) return;
      await fetch(API + "/api/trade/projects/" + id, { method: "DELETE", headers: authHeaders });
      loadTab("projects");
    };
    const deleteCollection = async (id) => {
      if (!confirm("Delete this collection and all its items?")) return;
      await fetch(API + "/api/trade/favorites/" + id, { method: "DELETE", headers: authHeaders });
      loadTab("favorites");
    };
    const expandQuote = async (quoteId) => {
      if (expandedQuote === quoteId) {
        setExpandedQuote(null);
        setQuoteDetail(null);
        return;
      }
      setExpandedQuote(quoteId);
      const resp = await fetch(API + "/api/trade/quotes/" + quoteId, { headers: authHeaders });
      const data = await resp.json();
      setQuoteDetail(data);
    };
    const expandVisit = async (visitId) => {
      if (expandedVisit === visitId) {
        setExpandedVisit(null);
        setVisitDetail(null);
        return;
      }
      setExpandedVisit(visitId);
      const resp = await fetch(API + "/api/trade/visits/" + visitId, { headers: authHeaders });
      const data = await resp.json();
      setVisitDetail(data);
    };
    const acceptQuote = async (quoteId) => {
      if (!confirm("Accept this quote and convert it to an order?")) return;
      const resp = await fetch(API + "/api/trade/quotes/" + quoteId + "/accept", { method: "POST", headers: authHeaders });
      if (resp.ok) {
        showToast("Quote accepted! Order has been created.", "success");
        loadTab("quotes");
      } else {
        const d = await resp.json();
        showToast(d.error || "Failed to accept quote", "error");
      }
    };
    const downloadQuotePdf = async (quoteId) => {
      try {
        const r = await fetch(API + "/api/trade/quotes/" + quoteId + "/pdf", { headers: { "X-Trade-Token": tradeToken } });
        if (!r.ok) throw new Error("Failed to load PDF");
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
      } catch (e) {
        console.error(e);
      }
    };
    const assignOrderProject = async (orderId, projectId) => {
      await fetch(API + "/api/trade/orders/" + orderId + "/project", {
        method: "PUT",
        headers,
        body: JSON.stringify({ project_id: projectId || null })
      });
      loadTab("orders");
    };
    const [editAccount, setEditAccount] = useState(false);
    const [accountForm, setAccountForm] = useState({});
    const [passwordForm, setPasswordForm] = useState({ current: "", new_password: "", confirm: "" });
    const [showPwForm, setShowPwForm] = useState(false);
    const saveAccount = async () => {
      await fetch(API + "/api/trade/account", { method: "PUT", headers, body: JSON.stringify(accountForm) });
      setEditAccount(false);
      loadTab("account");
    };
    const changePassword = async () => {
      if (passwordForm.new_password !== passwordForm.confirm) {
        showToast("Passwords do not match", "error");
        return;
      }
      const resp = await fetch(API + "/api/trade/change-password", {
        method: "POST",
        headers,
        body: JSON.stringify({ current_password: passwordForm.current, new_password: passwordForm.new_password })
      });
      if (resp.ok) {
        showToast("Password updated", "success");
        setShowPwForm(false);
        setPasswordForm({ current: "", new_password: "", confirm: "" });
      } else {
        const d = await resp.json();
        showToast(d.error || "Failed to change password", "error");
      }
    };
    const tabs = ["overview", "orders", "quotes", "visits", "projects", "favorites", "account"];
    const tabIcons = {
      overview: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7", rx: "1" })),
      orders: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })),
      quotes: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" }), /* @__PURE__ */ React.createElement("line", { x1: "16", y1: "13", x2: "8", y2: "13" }), /* @__PURE__ */ React.createElement("line", { x1: "16", y1: "17", x2: "8", y2: "17" })),
      visits: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" })),
      projects: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" })),
      favorites: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })),
      account: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" }))
    };
    return /* @__PURE__ */ React.createElement("div", { className: "trade-dashboard" }, /* @__PURE__ */ React.createElement("div", { className: "trade-dash-header" }, /* @__PURE__ */ React.createElement("h1", null, "Trade Dashboard"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.875rem", color: "var(--stone-500)" } }, tradeCustomer.company_name, /* @__PURE__ */ React.createElement("span", { className: "trade-tier-badge" }, tradeCustomer.tier_name || "Silver"))), /* @__PURE__ */ React.createElement("div", { className: "trade-dash-tabs" }, tabs.map((t) => /* @__PURE__ */ React.createElement("button", { key: t, className: "trade-dash-tab" + (tab === t ? " active" : ""), onClick: () => setTab(t) }, tabIcons[t], t.charAt(0).toUpperCase() + t.slice(1)))), loading ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "skeleton-stat-grid" }, [0, 1, 2, 3].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-stat-card" }))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2rem" } }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-table-row" })))) : /* @__PURE__ */ React.createElement(React.Fragment, null, tab === "overview" && dashData && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "trade-stat-grid" }, /* @__PURE__ */ React.createElement("div", { className: "trade-stat-card", style: { background: "linear-gradient(135deg, #fffbf0 0%, white 100%)" } }, /* @__PURE__ */ React.createElement("label", null, "Tier"), /* @__PURE__ */ React.createElement("div", { className: "value" }, dashData.tier_name || "Silver")), /* @__PURE__ */ React.createElement("div", { className: "trade-stat-card", style: { background: "linear-gradient(135deg, #f0fdf4 0%, white 100%)" } }, /* @__PURE__ */ React.createElement("label", null, "Total Spend"), /* @__PURE__ */ React.createElement("div", { className: "value" }, "$", parseFloat(dashData.total_spend || 0).toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "trade-stat-card", style: { background: "linear-gradient(135deg, #f0f9ff 0%, white 100%)" } }, /* @__PURE__ */ React.createElement("label", null, "Orders"), /* @__PURE__ */ React.createElement("div", { className: "value" }, dashData.order_count || 0)), /* @__PURE__ */ React.createElement("div", { className: "trade-stat-card", style: { background: "linear-gradient(135deg, #faf5ff 0%, white 100%)" } }, /* @__PURE__ */ React.createElement("label", null, "Membership"), /* @__PURE__ */ React.createElement("div", { className: "value", style: { fontSize: "1.25rem" } }, dashData.subscription_status === "active" ? "Active" : dashData.subscription_status || "Pending"))), dashData.next_tier_name && /* @__PURE__ */ React.createElement("div", { className: "trade-tier-progress" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("span", null, "Progress to ", /* @__PURE__ */ React.createElement("strong", null, dashData.next_tier_name)), /* @__PURE__ */ React.createElement("span", null, "$", parseFloat(dashData.total_spend || 0).toLocaleString(), " / $", parseFloat(dashData.next_tier_threshold || 0).toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "trade-tier-bar" }, /* @__PURE__ */ React.createElement("div", { className: "trade-tier-bar-fill", style: { width: Math.min(100, parseFloat(dashData.total_spend || 0) / parseFloat(dashData.next_tier_threshold || 1) * 100) + "%" } }))), dashData.recent_orders && dashData.recent_orders.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("h3", null, "Recent Orders"), /* @__PURE__ */ React.createElement("table", { className: "trade-orders-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Order #"), /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Total"), /* @__PURE__ */ React.createElement("th", null, "Status"))), /* @__PURE__ */ React.createElement("tbody", null, dashData.recent_orders.map((o) => /* @__PURE__ */ React.createElement("tr", { key: o.id }, /* @__PURE__ */ React.createElement("td", { style: { fontWeight: 500 } }, o.order_number), /* @__PURE__ */ React.createElement("td", null, new Date(o.created_at).toLocaleDateString()), /* @__PURE__ */ React.createElement("td", null, "$", parseFloat(o.total).toFixed(2)), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "trade-status-badge " + (o.status || "pending") }, o.status))))))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "1rem", marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Shop Products"))), tab === "orders" && /* @__PURE__ */ React.createElement("div", null, orders.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), /* @__PURE__ */ React.createElement("p", null, "No orders yet"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Start Shopping")) : /* @__PURE__ */ React.createElement("table", { className: "trade-orders-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Order #"), /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Items"), /* @__PURE__ */ React.createElement("th", null, "Total"), /* @__PURE__ */ React.createElement("th", null, "Status"), /* @__PURE__ */ React.createElement("th", null, "PO #"), /* @__PURE__ */ React.createElement("th", null, "Project"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, orders.map((o) => /* @__PURE__ */ React.createElement(React.Fragment, { key: o.id }, /* @__PURE__ */ React.createElement("tr", { onClick: () => setExpandedOrder(expandedOrder === o.id ? null : o.id), style: { cursor: "pointer" } }, /* @__PURE__ */ React.createElement("td", { style: { fontWeight: 500 } }, o.order_number), /* @__PURE__ */ React.createElement("td", null, new Date(o.created_at).toLocaleDateString()), /* @__PURE__ */ React.createElement("td", null, o.item_count), /* @__PURE__ */ React.createElement("td", null, "$", parseFloat(o.total).toFixed(2)), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "trade-status-badge " + (o.status || "pending") }, o.status)), /* @__PURE__ */ React.createElement("td", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, o.po_number || "\u2014"), /* @__PURE__ */ React.createElement("td", { onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement(
      "select",
      {
        value: o.project_id || "",
        onChange: (e) => assignOrderProject(o.id, e.target.value),
        style: { fontSize: "0.75rem", padding: "0.2rem", border: "1px solid var(--stone-300)" }
      },
      /* @__PURE__ */ React.createElement("option", { value: "" }, "None"),
      projects.map((p) => /* @__PURE__ */ React.createElement("option", { key: p.id, value: p.id }, p.name))
    )), /* @__PURE__ */ React.createElement("td", { style: { fontSize: "0.8125rem" } }, expandedOrder === o.id ? "\u25B2" : "\u25BC")), expandedOrder === o.id && o.items && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: "8", style: { background: "var(--stone-50)", padding: "1rem" } }, o.items.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, style: { display: "flex", justifyContent: "space-between", padding: "0.35rem 0", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("span", null, item.product_name, " \u2014 ", item.sku_code), /* @__PURE__ */ React.createElement("span", null, item.quantity, " x $", parseFloat(item.unit_price).toFixed(2))))))))))), tab === "quotes" && /* @__PURE__ */ React.createElement("div", null, quotes.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("table", { className: "trade-orders-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Quote #"), /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Items"), /* @__PURE__ */ React.createElement("th", null, "Total"), /* @__PURE__ */ React.createElement("th", null, "Expires"), /* @__PURE__ */ React.createElement("th", null, "Status"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, quotes.map((q) => {
      const isExpired = q.expires_at && new Date(q.expires_at) < /* @__PURE__ */ new Date();
      const daysLeft = q.expires_at ? Math.ceil((new Date(q.expires_at) - /* @__PURE__ */ new Date()) / (1e3 * 60 * 60 * 24)) : null;
      return /* @__PURE__ */ React.createElement(React.Fragment, { key: q.id }, /* @__PURE__ */ React.createElement("tr", { style: { cursor: "pointer" }, onClick: () => expandQuote(q.id) }, /* @__PURE__ */ React.createElement("td", { style: { fontWeight: 500 } }, q.quote_number || "Q-" + q.id.substring(0, 8).toUpperCase()), /* @__PURE__ */ React.createElement("td", null, new Date(q.created_at).toLocaleDateString()), /* @__PURE__ */ React.createElement("td", null, q.item_count || 0), /* @__PURE__ */ React.createElement("td", null, "$", parseFloat(q.total || 0).toFixed(2)), /* @__PURE__ */ React.createElement("td", null, q.expires_at ? /* @__PURE__ */ React.createElement("span", { style: { color: isExpired ? "#dc2626" : daysLeft <= 3 ? "#ea580c" : "inherit", fontWeight: isExpired || daysLeft <= 3 ? 600 : 400 } }, isExpired ? "Expired" : daysLeft + " days left") : "\u2014"), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "trade-status-badge " + (q.status || "draft") }, q.status === "converted" ? "Accepted" : q.status || "draft")), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "right" } }, /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: (e) => {
            e.stopPropagation();
            downloadQuotePdf(q.id);
          },
          style: { background: "none", border: "none", color: "var(--gold)", fontSize: "0.8125rem", cursor: "pointer", fontWeight: 500, marginRight: "0.5rem" }
        },
        "PDF"
      ), q.status !== "converted" && !isExpired && /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: (e) => {
            e.stopPropagation();
            acceptQuote(q.id);
          },
          className: "btn",
          style: { padding: "0.25rem 0.75rem", fontSize: "0.75rem" }
        },
        "Accept"
      ))), expandedQuote === q.id && quoteDetail && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: "7", style: { padding: "1rem 1.5rem", background: "#fafaf9" } }, /* @__PURE__ */ React.createElement("table", { style: { width: "100%", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", { style: { borderBottom: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Item"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, textAlign: "right" } }, "Qty"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, textAlign: "right" } }, "Unit Price"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, textAlign: "right" } }, "Subtotal"))), /* @__PURE__ */ React.createElement("tbody", null, (quoteDetail.items || []).map((item, i) => /* @__PURE__ */ React.createElement("tr", { key: i, style: { borderBottom: "1px solid #e7e5e4" } }, /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem" } }, item.product_name || ""), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", textAlign: "right" } }, item.num_boxes || item.quantity || 1), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", textAlign: "right" } }, "$", parseFloat(item.unit_price || 0).toFixed(2)), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", textAlign: "right" } }, "$", parseFloat(item.subtotal || 0).toFixed(2)))))), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right", marginTop: "0.75rem", fontWeight: 500 } }, "Total: $", parseFloat(q.total || 0).toFixed(2)))));
    })))) : /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" })), /* @__PURE__ */ React.createElement("p", null, "No quotes yet. Contact your trade representative to request a custom quote."))), tab === "visits" && /* @__PURE__ */ React.createElement("div", null, visits.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("table", { className: "trade-orders-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Products"), /* @__PURE__ */ React.createElement("th", null, "Status"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, visits.map((v) => /* @__PURE__ */ React.createElement(React.Fragment, { key: v.id }, /* @__PURE__ */ React.createElement("tr", { style: { cursor: "pointer" }, onClick: () => expandVisit(v.id) }, /* @__PURE__ */ React.createElement("td", { style: { fontWeight: 500 } }, new Date(v.sent_at || v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })), /* @__PURE__ */ React.createElement("td", null, v.item_count, " product", v.item_count !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: "trade-status-badge sent" }, "Showroom Visit")), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "right" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: {
      width: 16,
      height: 16,
      transform: expandedVisit === v.id ? "rotate(180deg)" : "rotate(0)",
      transition: "transform 0.2s"
    } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" })))), expandedVisit === v.id && visitDetail && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: "4", style: { padding: "1rem 1.5rem", background: "#fafaf9" } }, v.message && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af", fontStyle: "italic", borderRadius: "4px" } }, '"', v.message, '"'), /* @__PURE__ */ React.createElement("table", { style: { width: "100%", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", { style: { borderBottom: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, width: 56 } }), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Product"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Variant"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, textAlign: "right" } }, "Price"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Note"))), /* @__PURE__ */ React.createElement("tbody", null, (visitDetail.items || []).map((item, i) => /* @__PURE__ */ React.createElement("tr", { key: i, style: { borderBottom: "1px solid #e7e5e4" } }, /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image, 100), alt: "", style: { width: 40, height: 40, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" })), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection)), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", color: "var(--stone-600)" } }, item.variant_name || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", textAlign: "right" } }, skuListPrice(item) ? `$${displayPrice(item, skuListPrice(item)).toFixed(2)}${priceSuffix(item)}` : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", color: "var(--stone-500)", fontSize: "0.75rem", maxWidth: 180 } }, item.rep_note || "")))))))))))) : /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" })), /* @__PURE__ */ React.createElement("p", null, "No showroom visits yet. After visiting our showroom, your product recommendations will appear here."))), tab === "projects" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, projects.length, " project", projects.length !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      setShowProjectForm(true);
      setEditingProject(null);
      setProjectForm({ name: "", client_name: "", address: "", notes: "" });
    } }, "New Project")), showProjectForm && /* @__PURE__ */ React.createElement("div", { className: "trade-card", style: { marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("h3", null, editingProject ? "Edit Project" : "New Project"), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Project Name *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: projectForm.name, onChange: (e) => setProjectForm({ ...projectForm, name: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Client Name"), /* @__PURE__ */ React.createElement("input", { type: "text", value: projectForm.client_name, onChange: (e) => setProjectForm({ ...projectForm, client_name: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Address"), /* @__PURE__ */ React.createElement("input", { type: "text", value: projectForm.address, onChange: (e) => setProjectForm({ ...projectForm, address: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Notes"), /* @__PURE__ */ React.createElement("input", { type: "text", value: projectForm.notes, onChange: (e) => setProjectForm({ ...projectForm, notes: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setShowProjectForm(false) }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveProject, disabled: !projectForm.name }, "Save"))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1rem" } }, projects.map((p) => /* @__PURE__ */ React.createElement("div", { key: p.id, className: "trade-project-card", onClick: () => {
      setEditingProject(p.id);
      setProjectForm({ name: p.name, client_name: p.client_name || "", address: p.address || "", notes: p.notes || "" });
      setShowProjectForm(true);
    } }, /* @__PURE__ */ React.createElement("h4", null, p.name), p.client_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, p.client_name), p.address && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, p.address), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.75rem", color: "var(--stone-400)" } }, p.order_count || 0, " order", (p.order_count || 0) !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: (e) => {
          e.stopPropagation();
          deleteProject(p.id);
        },
        style: { background: "none", border: "none", color: "#dc2626", fontSize: "0.75rem", cursor: "pointer" }
      },
      "Delete"
    ))))), projects.length === 0 && !showProjectForm && /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" })), /* @__PURE__ */ React.createElement("p", null, "No projects yet. Create one to organize your orders."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      setShowProjectForm(true);
      setEditingProject(null);
      setProjectForm({ name: "", client_name: "", address: "", notes: "" });
    } }, "New Project"))), tab === "favorites" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, favorites.length, " collection", favorites.length !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => setShowFavForm(true) }, "New Collection")), showFavForm && /* @__PURE__ */ React.createElement("div", { className: "trade-card", style: { marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Collection Name"), /* @__PURE__ */ React.createElement("input", { type: "text", value: favName, onChange: (e) => setFavName(e.target.value) })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setShowFavForm(false) }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: createCollection }, "Create"))), favorites.map((col) => /* @__PURE__ */ React.createElement("div", { key: col.id, className: "trade-card", style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("h3", null, col.collection_name), /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => deleteCollection(col.id),
        style: { background: "none", border: "none", color: "#dc2626", fontSize: "0.8125rem", cursor: "pointer" }
      },
      "Delete"
    )), col.items && col.items.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-fav-grid" }, col.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "trade-fav-item" }, item.primary_image_url ? /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image_url, 400), alt: item.product_name, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { style: { height: 140, background: "var(--stone-100)" } }), /* @__PURE__ */ React.createElement("div", { className: "name" }, item.product_name), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "btn",
        style: { marginTop: "0.5rem", fontSize: "0.75rem", padding: "0.35rem 0.75rem" },
        onClick: () => addToCart({ product_id: item.product_id, sku_id: item.sku_id, sqft_needed: 1, num_boxes: 1, unit_price: parseFloat(item.retail_price || item.price || 0), subtotal: parseFloat(item.retail_price || item.price || 0).toFixed(2) })
      },
      "Add to Cart"
    )))) : /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.875rem" } }, "No items in this collection yet."))), favorites.length === 0 && !showFavForm && /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), /* @__PURE__ */ React.createElement("p", null, "No collections yet. Create one to save your favorite products."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => setShowFavForm(true) }, "New Collection"))), tab === "account" && account && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("h3", null, "Company Information"), !editAccount && /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => {
          setEditAccount(true);
          setAccountForm({ contact_name: account.contact_name, phone: account.phone || "", company_name: account.company_name });
        },
        style: { background: "none", border: "none", color: "var(--gold)", fontSize: "0.8125rem", cursor: "pointer", fontWeight: 500 }
      },
      "Edit"
    )), editAccount ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Company Name"), /* @__PURE__ */ React.createElement("input", { value: accountForm.company_name || "", onChange: (e) => setAccountForm({ ...accountForm, company_name: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Contact Name"), /* @__PURE__ */ React.createElement("input", { value: accountForm.contact_name || "", onChange: (e) => setAccountForm({ ...accountForm, contact_name: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone"), /* @__PURE__ */ React.createElement("input", { value: accountForm.phone || "", onChange: (e) => setAccountForm({ ...accountForm, phone: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setEditAccount(false) }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveAccount }, "Save"))) : /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.875rem", lineHeight: 2 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, account.company_name)), /* @__PURE__ */ React.createElement("div", null, account.contact_name), /* @__PURE__ */ React.createElement("div", null, account.email), account.phone && /* @__PURE__ */ React.createElement("div", null, account.phone))), /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("h3", null, "Membership"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.875rem", lineHeight: 2 } }, /* @__PURE__ */ React.createElement("div", null, "Tier: ", /* @__PURE__ */ React.createElement("span", { className: "trade-tier-badge" }, account.tier_name || "Silver")), /* @__PURE__ */ React.createElement("div", null, "Status: ", membership && membership.subscription_status === "active" ? "Active" : membership ? membership.subscription_status : "Pending"), membership && membership.subscription_expires_at && /* @__PURE__ */ React.createElement("div", null, "Renews: ", new Date(membership.subscription_expires_at).toLocaleDateString()), /* @__PURE__ */ React.createElement("div", null, "Total Spend: $", parseFloat(account.total_spend || 0).toLocaleString())), membership && membership.subscription_status === "active" && /* @__PURE__ */ React.createElement("button", { onClick: cancelMembership, style: { marginTop: "1rem", background: "none", border: "1px solid #dc2626", color: "#dc2626", padding: "0.5rem 1rem", fontSize: "0.8125rem", cursor: "pointer" } }, "Cancel Membership"))), rep && /* @__PURE__ */ React.createElement("div", { className: "trade-rep-card", style: { marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-rep-avatar" }, (rep.first_name || "R").charAt(0), (rep.last_name || "").charAt(0)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, marginBottom: "0.25rem" } }, "Your Trade Representative"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.875rem", color: "var(--stone-600)" } }, rep.first_name, " ", rep.last_name), rep.email && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, rep.email), rep.phone && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, rep.phone))), /* @__PURE__ */ React.createElement("div", { className: "trade-card", style: { marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("h3", null, "Security"), !showPwForm && /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => setShowPwForm(true),
        style: { background: "none", border: "none", color: "var(--gold)", fontSize: "0.8125rem", cursor: "pointer", fontWeight: 500 }
      },
      "Change Password"
    )), showPwForm && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Current Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: passwordForm.current, onChange: (e) => setPasswordForm({ ...passwordForm, current: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "New Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: passwordForm.new_password, onChange: (e) => setPasswordForm({ ...passwordForm, new_password: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Confirm Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: passwordForm.confirm, onChange: (e) => setPasswordForm({ ...passwordForm, confirm: e.target.value }) })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setShowPwForm(false) }, "Cancel"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: changePassword, disabled: !passwordForm.current || !passwordForm.new_password }, "Update Password")))))));
  }
  function CollectionsPage({ onCollectionClick, goHome }) {
    const [collections, setCollections] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      fetch(API + "/api/collections").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setCollections(data.collections || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    }, []);
    return /* @__PURE__ */ React.createElement("div", { className: "collections-page" }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: [
      { label: "Home", onClick: goHome },
      { label: "Collections" }
    ] }), /* @__PURE__ */ React.createElement("h1", null, "Collections"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our curated flooring collections from premium vendors worldwide."), loading ? /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-collection-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })))) : collections.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", null, "No collections available yet.")) : /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, collections.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.slug, className: "collection-card", onClick: () => onCollectionClick(c.name) }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-image" }, c.image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(c.image, 400), alt: c.name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "collection-card-info" }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-name" }, c.name), /* @__PURE__ */ React.createElement("div", { className: "collection-card-count" }, c.product_count, " product", c.product_count !== 1 ? "s" : ""))))));
  }
  function FloorQuizModal({ onClose, onSkuClick, onViewAll }) {
    const [step, setStep] = useState(1);
    const [room, setRoom] = useState("");
    const [style, setStyle] = useState("");
    const [durability, setDurability] = useState("");
    const [budget, setBudget] = useState("");
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [filterParams, setFilterParams] = useState("");
    useEffect(() => {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }, []);
    const rooms = [
      { id: "kitchen", label: "Kitchen", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "2", width: "20", height: "20", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "2", y1: "10", x2: "22", y2: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "10", x2: "12", y2: "22" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "6", r: "1.5" }), /* @__PURE__ */ React.createElement("circle", { cx: "17", cy: "6", r: "1.5" })) },
      { id: "bathroom", label: "Bathroom", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M4 12h16a1 1 0 011 1v3a4 4 0 01-4 4H7a4 4 0 01-4-4v-3a1 1 0 011-1z" }), /* @__PURE__ */ React.createElement("path", { d: "M6 12V5a2 2 0 012-2h1" }), /* @__PURE__ */ React.createElement("line", { x1: "2", y1: "20", x2: "5", y2: "22" }), /* @__PURE__ */ React.createElement("line", { x1: "22", y1: "20", x2: "19", y2: "22" })) },
      { id: "living-room", label: "Living Room", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v3" }), /* @__PURE__ */ React.createElement("path", { d: "M2 11v5a2 2 0 002 2h16a2 2 0 002-2v-5a2 2 0 00-4 0H6a2 2 0 00-4 0z" }), /* @__PURE__ */ React.createElement("line", { x1: "4", y1: "18", x2: "4", y2: "21" }), /* @__PURE__ */ React.createElement("line", { x1: "20", y1: "18", x2: "20", y2: "21" })) },
      { id: "bedroom", label: "Bedroom", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M2 12h20v7H2z" }), /* @__PURE__ */ React.createElement("path", { d: "M2 12V8a4 4 0 014-4h12a4 4 0 014 4v4" }), /* @__PURE__ */ React.createElement("rect", { x: "6", y: "8", width: "4", height: "4", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "8", width: "4", height: "4", rx: "1" }), /* @__PURE__ */ React.createElement("line", { x1: "2", y1: "19", x2: "2", y2: "22" }), /* @__PURE__ */ React.createElement("line", { x1: "22", y1: "19", x2: "22", y2: "22" })) },
      { id: "outdoor", label: "Outdoor", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "5", r: "3" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "8", x2: "12", y2: "16" }), /* @__PURE__ */ React.createElement("path", { d: "M5 22l3-8h8l3 8" }), /* @__PURE__ */ React.createElement("line", { x1: "5", y1: "22", x2: "19", y2: "22" })) },
      { id: "commercial", label: "Commercial", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "4", y: "2", width: "16", height: "20", rx: "1" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "6", x2: "15", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "10", x2: "15", y2: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "14", x2: "15", y2: "14" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "18", x2: "15", y2: "18" })) }
    ];
    const styles = [
      { id: "modern", label: "Modern", desc: "Clean lines, minimal" },
      { id: "traditional", label: "Traditional", desc: "Classic, timeless" },
      { id: "rustic", label: "Rustic", desc: "Warm, natural feel" },
      { id: "coastal", label: "Coastal", desc: "Light, breezy" },
      { id: "mediterranean", label: "Mediterranean", desc: "Earthy, textured" },
      { id: "contemporary", label: "Contemporary", desc: "Bold, current" }
    ];
    const durabilities = [
      { id: "light", label: "Light Traffic", desc: "Bedrooms, closets" },
      { id: "medium", label: "Medium Traffic", desc: "Living rooms, dining" },
      { id: "heavy", label: "Heavy Traffic", desc: "Kitchens, hallways" },
      { id: "waterproof", label: "Waterproof", desc: "Baths, laundry, outdoor" },
      { id: "commercial", label: "Commercial", desc: "Retail, office spaces" },
      { id: "any", label: "No Preference", desc: "Show me everything" }
    ];
    const budgets = [
      { id: "under3", label: "$", desc: "Under $3/sqft" },
      { id: "3to6", label: "$$", desc: "$3\u2013$6/sqft" },
      { id: "6to10", label: "$$$", desc: "$6\u2013$10/sqft" },
      { id: "over10", label: "$$$$", desc: "$10+/sqft" },
      { id: "any", label: "Any", desc: "Show all price ranges" }
    ];
    const buildFilters = () => {
      const params = new URLSearchParams();
      const roomCatMap = {
        "kitchen": "tile",
        "bathroom": "tile",
        "living-room": "hardwood",
        "bedroom": "hardwood",
        "outdoor": "tile",
        "commercial": "luxury-vinyl"
      };
      const styleCatOverrides = {
        "rustic": { "living-room": "hardwood", "bedroom": "hardwood" },
        "modern": { "living-room": "luxury-vinyl", "kitchen": "luxury-vinyl" },
        "coastal": { "living-room": "luxury-vinyl", "bedroom": "laminate-flooring" }
      };
      let cat = roomCatMap[room] || "";
      if (styleCatOverrides[style] && styleCatOverrides[style][room]) {
        cat = styleCatOverrides[style][room];
      }
      if (durability === "waterproof" && cat === "hardwood") cat = "luxury-vinyl";
      if (cat) params.set("category", cat);
      params.set("limit", "8");
      params.set("sort", "newest");
      return params.toString();
    };
    const fetchResults = async () => {
      setLoading(true);
      const qs = buildFilters();
      setFilterParams(qs);
      try {
        const res = await fetch(API + "/api/storefront/skus?" + qs);
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
    const stepLabels = ["Room", "Style", "Durability", "Budget", "Results"];
    return /* @__PURE__ */ React.createElement("div", { className: "quiz-overlay", onClick: (e) => {
      if (e.target === e.currentTarget) onClose();
    } }, /* @__PURE__ */ React.createElement("div", { className: "quiz-modal" }, /* @__PURE__ */ React.createElement("button", { className: "quiz-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "quiz-progress" }, [1, 2, 3, 4, 5].map((s) => /* @__PURE__ */ React.createElement("div", { key: s, className: "quiz-progress-step" + (s === step ? " active" : "") + (s < step ? " done" : "") }))), step <= 4 && /* @__PURE__ */ React.createElement("p", { className: "quiz-step-label" }, "Step ", step, " of 4 \u2014 ", stepLabels[step - 1]), step === 1 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "What room is this for?"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "We'll recommend the best flooring for your space"), /* @__PURE__ */ React.createElement("div", { className: "quiz-options" }, rooms.map((r) => /* @__PURE__ */ React.createElement("div", { key: r.id, className: "quiz-option" + (room === r.id ? " selected" : ""), onClick: () => setRoom(r.id) }, /* @__PURE__ */ React.createElement("span", { className: "quiz-option-icon" }, r.icon), /* @__PURE__ */ React.createElement("span", { className: "quiz-option-label" }, r.label))))), step === 2 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "What's your style?"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Choose the look that speaks to you"), /* @__PURE__ */ React.createElement("div", { className: "quiz-options" }, styles.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.id, className: "quiz-option" + (style === s.id ? " selected" : ""), onClick: () => setStyle(s.id) }, /* @__PURE__ */ React.createElement("span", { className: "quiz-option-label" }, s.label), /* @__PURE__ */ React.createElement("span", { className: "quiz-option-desc" }, s.desc))))), step === 3 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "How much traffic?"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Helps us pick the right durability rating"), /* @__PURE__ */ React.createElement("div", { className: "quiz-options" }, durabilities.map((d) => /* @__PURE__ */ React.createElement("div", { key: d.id, className: "quiz-option" + (durability === d.id ? " selected" : ""), onClick: () => setDurability(d.id) }, /* @__PURE__ */ React.createElement("span", { className: "quiz-option-label" }, d.label), /* @__PURE__ */ React.createElement("span", { className: "quiz-option-desc" }, d.desc))))), step === 4 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "What's your budget?"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Per square foot pricing"), /* @__PURE__ */ React.createElement("div", { className: "quiz-options", style: { gridTemplateColumns: "repeat(5, 1fr)" } }, budgets.map((b) => /* @__PURE__ */ React.createElement("div", { key: b.id, className: "quiz-option" + (budget === b.id ? " selected" : ""), onClick: () => setBudget(b.id) }, /* @__PURE__ */ React.createElement("span", { className: "quiz-option-label" }, b.label), /* @__PURE__ */ React.createElement("span", { className: "quiz-option-desc" }, b.desc))))), step === 5 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "quiz-results-header" }, /* @__PURE__ */ React.createElement("h2", null, "Your Recommendations"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Based on your preferences, we think you'll love these"), /* @__PURE__ */ React.createElement("div", { className: "quiz-results-tags" }, room && /* @__PURE__ */ React.createElement("span", { className: "quiz-results-tag" }, rooms.find((r) => r.id === room)?.label), style && /* @__PURE__ */ React.createElement("span", { className: "quiz-results-tag" }, styles.find((s) => s.id === style)?.label), durability && durability !== "any" && /* @__PURE__ */ React.createElement("span", { className: "quiz-results-tag" }, durabilities.find((d) => d.id === durability)?.label), budget && budget !== "any" && /* @__PURE__ */ React.createElement("span", { className: "quiz-results-tag" }, budgets.find((b) => b.id === budget)?.desc))), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 4 }) : results.length > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "quiz-results-grid" }, results.slice(0, 8).map((sku) => /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "quiz-result-card", onClick: () => {
      onClose();
      onSkuClick(sku.sku_id, sku.product_name);
    } }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(sku.primary_image, 400), alt: sku.product_name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-info" }, /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-name" }, sku.product_name), /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-price" }, skuListPrice(sku) ? "$" + displayPrice(sku, skuListPrice(sku)).toFixed(2) + priceSuffix(sku) : ""))))), /* @__PURE__ */ React.createElement("button", { className: "quiz-view-all", onClick: () => {
      onClose();
      onViewAll(filterParams);
    } }, "View All Results \u2192")) : /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "2rem", color: "var(--stone-500)" } }, /* @__PURE__ */ React.createElement("p", null, "No exact matches found. Try browsing our full collection."), /* @__PURE__ */ React.createElement("button", { className: "quiz-view-all", style: { marginTop: "1rem" }, onClick: () => {
      onClose();
      onViewAll("");
    } }, "Browse All Floors"))), step <= 4 && /* @__PURE__ */ React.createElement("div", { className: "quiz-nav" }, step > 1 ? /* @__PURE__ */ React.createElement("button", { className: "quiz-nav-back", onClick: () => setStep(step - 1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" })), "Back") : /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement("button", { className: "quiz-nav-next", disabled: !canNext(), onClick: handleNext }, step === 4 ? "See Results" : "Next")), step === 5 && !loading && /* @__PURE__ */ React.createElement("div", { className: "quiz-nav", style: { marginTop: "1rem" } }, /* @__PURE__ */ React.createElement("button", { className: "quiz-nav-back", onClick: () => {
      setStep(1);
      setRoom("");
      setStyle("");
      setDurability("");
      setBudget("");
      setResults([]);
    } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" })), "Start Over"), /* @__PURE__ */ React.createElement("span", null))));
  }
  function TradeModal({ onClose, onLogin, initialMode }) {
    const [mode, setMode] = useState(initialMode || "login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [companyName, setCompanyName] = useState("");
    const [contactName, setContactName] = useState("");
    const [phone, setPhone] = useState("");
    const [businessType, setBusinessType] = useState("");
    const [addressLine1, setAddressLine1] = useState("");
    const [city, setCity] = useState("");
    const [addrState, setAddrState] = useState("");
    const [zip, setZip] = useState("");
    const [contractorLicense, setContractorLicense] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    useEffect(() => {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }, []);
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState(1);
    const [docs, setDocs] = useState({ ein: null, resale_cert: null, business_card: null });
    const [docUploads, setDocUploads] = useState({});
    const [uploading, setUploading] = useState("");
    const [setupIntentSecret, setSetupIntentSecret] = useState(null);
    const cardRef = useRef(null);
    const cardMounted = useRef(false);
    const handleLogin = async (e) => {
      e.preventDefault();
      setError("");
      setSuccess("");
      setLoading(true);
      try {
        const resp = await fetch(API + "/api/trade/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data.error);
          setLoading(false);
          return;
        }
        onLogin(data.token, data.customer);
      } catch (err) {
        setError("Network error. Please try again.");
      }
      setLoading(false);
    };
    const formatPhone = (val) => {
      const digits = val.replace(/\D/g, "").slice(0, 10);
      if (digits.length === 0) return "";
      if (digits.length <= 3) return "(" + digits;
      if (digits.length <= 6) return "(" + digits.slice(0, 3) + ") " + digits.slice(3);
      return "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
    };
    const handlePhoneChange = (e) => {
      setPhone(formatPhone(e.target.value));
    };
    const passwordValid = password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const [emailTouched, setEmailTouched] = useState(false);
    const goStep2 = () => {
      if (!companyName || !contactName || !email || !password || !businessType || !phone || !addressLine1 || !city || !addrState || !zip) {
        setError("Please fill in all required fields.");
        return;
      }
      if (!emailValid) {
        setError("Please enter a valid email address.");
        return;
      }
      if (phone.replace(/\D/g, "").length < 10) {
        setError("Please enter a valid 10-digit phone number.");
        return;
      }
      if (!passwordValid) {
        setError("Password must be at least 8 characters with one uppercase letter and one number.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
      setError("");
      setStep(2);
    };
    const handleDocUpload = async (docType, file) => {
      if (!file) return;
      setUploading(docType);
      setError("");
      try {
        const formData = new FormData();
        formData.append("document", file);
        formData.append("doc_type", docType);
        formData.append("email", email);
        const resp = await fetch(API + "/api/trade/register/upload", { method: "POST", body: formData });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          setError(errData.error || "Upload failed");
          setUploading("");
          return;
        }
        const data = await resp.json();
        setDocUploads((prev) => ({ ...prev, [docType]: { id: data.document_id, file_name: file.name } }));
      } catch (err) {
        setError("Upload failed. Please try again.");
      }
      setUploading("");
    };
    const goStep3 = async () => {
      if (!docUploads.ein || !docUploads.resale_cert || !docUploads.business_card) {
        setError("EIN certificate, Resale Certificate, and Business Card are required.");
        return;
      }
      setError("");
      setLoading(true);
      try {
        const resp = await fetch(API + "/api/trade/register/setup-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data.error);
          setLoading(false);
          return;
        }
        setSetupIntentSecret(data.client_secret);
        setStep(3);
      } catch (err) {
        setError("Network error. Please try again.");
      }
      setLoading(false);
    };
    useEffect(() => {
      let timerId = null;
      if (step === 3 && !cardMounted.current && setupIntentSecret && stripeInstance) {
        timerId = setTimeout(() => {
          const el = document.getElementById("trade-card-element");
          if (!el) return;
          const elements = stripeInstance.elements();
          const card = elements.create("card", {
            style: { base: { fontFamily: "'Inter', sans-serif", fontSize: "15px", color: "#292524", "::placeholder": { color: "#57534e" } } }
          });
          card.mount("#trade-card-element");
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
      setError("");
      setLoading(true);
      try {
        const { error: stripeError, setupIntent } = await stripeInstance.confirmCardSetup(setupIntentSecret, {
          payment_method: { card: cardRef.current, billing_details: { name: contactName, email } }
        });
        if (stripeError) {
          setError(stripeError.message);
          setLoading(false);
          return;
        }
        const docIds = Object.values(docUploads).map((d) => d.id);
        const resp = await fetch(API + "/api/trade/register/enhanced", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            company_name: companyName,
            contact_name: contactName,
            phone,
            business_type: businessType,
            address_line1: addressLine1,
            city,
            state: addrState,
            zip,
            contractor_license: contractorLicense || null,
            document_ids: docIds,
            stripe_setup_intent_id: setupIntent.id
          })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data.error);
          setLoading(false);
          return;
        }
        setStep(4);
        setSuccess(data.message || "Application submitted! We will review your application and email you once approved.");
      } catch (err) {
        setError("Registration failed. Please try again.");
      }
      setLoading(false);
    };
    const stepLabels = ["Company", "Documents", "Payment", "Done"];
    const docLabel = (type) => ({ ein: "EIN Certificate *", resale_cert: "Resale Certificate *", business_card: "Business Card *" })[type] || type;
    return /* @__PURE__ */ React.createElement("div", { className: "trade-modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "trade-modal", onClick: (e) => e.stopPropagation(), style: mode === "register" ? { maxWidth: "480px" } : {} }, /* @__PURE__ */ React.createElement("button", { className: "trade-modal-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", marginBottom: "1.5rem" } }, mode === "login" ? "Trade Login" : step === 4 ? "Application Submitted" : "Trade Registration"), error && /* @__PURE__ */ React.createElement("div", { className: "trade-msg trade-msg-error" }, error), success && /* @__PURE__ */ React.createElement("div", { className: "trade-msg trade-msg-success" }, success), mode === "login" ? /* @__PURE__ */ React.createElement("form", { onSubmit: handleLogin }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true })), /* @__PURE__ */ React.createElement("button", { className: "btn", type: "submit", disabled: loading, style: { width: "100%", marginTop: "0.5rem" } }, loading ? "Signing in..." : "Sign In"), /* @__PURE__ */ React.createElement("div", { className: "trade-toggle" }, "Don't have an account? ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      setMode("register");
      setError("");
      setSuccess("");
    } }, "Apply for Trade"))) : step === 4 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "1rem 0" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", lineHeight: 1.6, marginBottom: "1.5rem" } }, "Your application is under review. You'll receive an email once approved."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: onClose, style: { width: "100%" } }, "Close")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "trade-steps-indicator" }, stepLabels.slice(0, 3).map((s, i) => /* @__PURE__ */ React.createElement("div", { key: s, className: "trade-step-dot" + (step === i + 1 ? " active" : step > i + 1 ? " done" : "") }, s))), step === 1 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Company Name *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: companyName, onChange: (e) => setCompanyName(e.target.value), autoComplete: "organization" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Contact Name *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: contactName, onChange: (e) => setContactName(e.target.value), autoComplete: "name" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Business Type *"), /* @__PURE__ */ React.createElement("select", { value: businessType, onChange: (e) => setBusinessType(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select..."), /* @__PURE__ */ React.createElement("option", { value: "contractor" }, "General Contractor"), /* @__PURE__ */ React.createElement("option", { value: "interior_designer" }, "Interior Designer"), /* @__PURE__ */ React.createElement("option", { value: "architect" }, "Architect"), /* @__PURE__ */ React.createElement("option", { value: "builder" }, "Builder / Developer"), /* @__PURE__ */ React.createElement("option", { value: "retailer" }, "Flooring Retailer"), /* @__PURE__ */ React.createElement("option", { value: "other" }, "Other"))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), onBlur: () => setEmailTouched(true), autoComplete: "email", style: emailTouched && email && !emailValid ? { borderColor: "#dc2626" } : {} }), emailTouched && email && !emailValid && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: "#dc2626" } }, "Please enter a valid email")), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone *"), /* @__PURE__ */ React.createElement("input", { type: "tel", value: phone, onChange: handlePhoneChange, autoComplete: "tel", placeholder: "(555) 123-4567" }))), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Address *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: addressLine1, onChange: (e) => setAddressLine1(e.target.value), autoComplete: "address-line1", placeholder: "Street address" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "City *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: city, onChange: (e) => setCity(e.target.value), autoComplete: "address-level2" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "State *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: addrState, onChange: (e) => setAddrState(e.target.value), maxLength: "2", placeholder: "CA", style: { textTransform: "uppercase" }, autoComplete: "address-level1" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Zip *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: zip, onChange: (e) => setZip(e.target.value), maxLength: "10", placeholder: "90210", autoComplete: "postal-code" }))), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Password *"), /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), autoComplete: "new-password" }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: password ? passwordValid ? "#16a34a" : "var(--stone-400)" : "var(--stone-400)" } }, "Min 8 characters, one uppercase, one number")), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Confirm Password *"), /* @__PURE__ */ React.createElement("input", { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), autoComplete: "new-password" }), confirmPassword && confirmPassword !== password && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: "#dc2626" } }, "Passwords do not match")), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goStep2, style: { width: "100%", marginTop: "0.5rem" } }, "Continue"), /* @__PURE__ */ React.createElement("div", { className: "trade-toggle" }, "Already have an account? ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      setMode("login");
      setError("");
      setSuccess("");
      setStep(1);
    } }, "Sign In"))), step === 2 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "1rem", lineHeight: 1.5 } }, "Upload your business documents for verification. EIN, Resale Certificate, and Business Card are required."), ["ein", "resale_cert", "business_card"].map((docType) => /* @__PURE__ */ React.createElement("div", { key: docType }, /* @__PURE__ */ React.createElement("label", { style: { display: "block", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--stone-500)", marginBottom: "0.35rem" } }, docLabel(docType)), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "trade-doc-upload" + (docUploads[docType] ? " uploaded" : ""),
        onClick: () => {
          const inp = document.getElementById("doc-" + docType);
          if (inp) inp.click();
        }
      },
      uploading === docType ? "Uploading..." : docUploads[docType] ? docUploads[docType].file_name : "Click to upload",
      /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "file",
          id: "doc-" + docType,
          accept: ".pdf,.jpg,.jpeg,.png",
          style: { display: "none" },
          onChange: (e) => handleDocUpload(docType, e.target.files[0])
        }
      )
    ))), /* @__PURE__ */ React.createElement("div", { className: "trade-field", style: { marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("label", null, "Contractor License # (optional)"), /* @__PURE__ */ React.createElement("input", { type: "text", value: contractorLicense, onChange: (e) => setContractorLicense(e.target.value), placeholder: "e.g. 830966" })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setStep(1) }, "Back"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goStep3, disabled: loading }, loading ? "Setting up..." : "Continue"))), step === 3 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "1rem", lineHeight: 1.5 } }, "Add a payment method for your $99/year trade membership. You won't be charged until approved."), /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--stone-300)", padding: "1rem", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("div", { id: "trade-card-element" })), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setStep(2) }, "Back"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: handleFullRegister, disabled: loading }, loading ? "Submitting..." : "Submit Application"))))));
  }
  function GoogleSignInButton({ onCredentialResponse }) {
    const containerRef = useRef(null);
    const [ready, setReady] = useState(false);
    const [clientId, setClientId] = useState(null);
    useEffect(() => {
      fetch(API + "/api/config/google-client-id").then((r) => r.json()).then((data) => {
        if (data.clientId) setClientId(data.clientId);
      }).catch(() => {
      });
    }, []);
    useEffect(() => {
      if (!clientId || !containerRef.current) return;
      const tryInit = () => {
        if (typeof google === "undefined" || !google.accounts || !google.accounts.id) return false;
        try {
          google.accounts.id.initialize({
            client_id: clientId,
            callback: (response) => {
              if (response.credential) onCredentialResponse(response.credential);
            },
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
        } catch (e) {
          console.warn("Google Sign-In init error:", e);
        }
        return true;
      };
      if (tryInit()) return;
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 200);
      const timeout = setTimeout(() => clearInterval(interval), 8e3);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
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
  function AuthPageShell({ children, panelKind, panelTone, panelImage, panelEyebrow, panelHeadline, panelSub, panelAttribution, goHome }) {
    const bgStyle = panelImage ? { backgroundImage: "url(" + panelImage + ")", backgroundSize: "cover", backgroundPosition: "center" } : materialFace(panelKind, panelTone);
    return /* @__PURE__ */ React.createElement(
      "div",
      { className: "auth-page" },
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-form-col" },
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-header" },
          /* @__PURE__ */ React.createElement("a", { className: "auth-header-logo", onClick: goHome }, "Roma"),
          /* @__PURE__ */ React.createElement("span", { className: "auth-header-tagline" }, "Anaheim, CA \xB7 Since 1999")
        ),
        /* @__PURE__ */ React.createElement("div", { className: "auth-form-col-inner" }, children),
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-footer" },
          /* @__PURE__ */ React.createElement("span", null, "\xA9 2026 Roma Flooring Designs"),
          /* @__PURE__ */ React.createElement(
            "span",
            { className: "auth-footer-links" },
            /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "Privacy"),
            /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms"),
            /* @__PURE__ */ React.createElement("a", null, "Help")
          )
        )
      ),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-panel" },
        /* @__PURE__ */ React.createElement("div", { className: "auth-panel-bg", style: bgStyle }),
        /* @__PURE__ */ React.createElement("div", { className: "auth-panel-overlay" }),
        /* @__PURE__ */ React.createElement("div", { className: "auth-panel-eyebrow" }, panelEyebrow),
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-panel-content" },
          /* @__PURE__ */ React.createElement("h2", { className: "auth-panel-headline" }, panelHeadline),
          panelSub && /* @__PURE__ */ React.createElement("p", { className: "auth-panel-sub" }, panelSub),
          panelAttribution && /* @__PURE__ */ React.createElement("div", { className: "auth-panel-attribution" }, panelAttribution)
        )
      )
    );
  }
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
      } catch (e2) {
        setError("Unable to sign in. Please try again.");
        setLoading(false);
      }
    };
    return /* @__PURE__ */ React.createElement(
      AuthPageShell,
      {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1659362549741-c32157cc71f4?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Colonnata \xB7 Massa-Carrara, Italy",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Two and a half thousand SKUs, ", /* @__PURE__ */ React.createElement("em", null, "one cart"), "."),
        panelSub: "Sign in to pick up your saved quote, track your slab, or message your rep. Your account moves with you \u2014 phone, laptop, showroom."
      },
      /* @__PURE__ */ React.createElement(
        "div",
        null,
        /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Welcome back"),
        /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Sign in")
      ),
      error && (error === "__password_not_set__" ? /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-error" },
        "Your account was created in our showroom. ",
        /* @__PURE__ */ React.createElement("a", { style: { fontWeight: 600, textDecoration: "underline", cursor: "pointer" }, onClick: () => navigate("/signup") }, "Create a password"),
        " to get started, or check your email for a welcome link."
      ) : /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error)),
      /* @__PURE__ */ React.createElement(GoogleSignInButton, { onCredentialResponse: handleGoogleCredential }),
      googleError && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, googleError),
      googleLoading && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", fontSize: "0.8125rem", color: "var(--stone-500)" } }, "Signing in with Google\u2026"),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-divider" },
        /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" }),
        "or sign in with email",
        /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" })
      ),
      /* @__PURE__ */ React.createElement(
        "form",
        { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-field" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Email"),
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-field-row" },
            /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
          )
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-field" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Password"),
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-field-row" },
            /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "current-password" }),
            /* @__PURE__ */ React.createElement("a", { className: "auth-field-right", onClick: () => navigate("/forgot-password") }, "Forgot? \u2192")
          )
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          { style: { display: "grid", gap: 14 } },
          /* @__PURE__ */ React.createElement(
            "label",
            { className: "auth-checkbox", onClick: (e) => {
              e.preventDefault();
              setRemember(!remember);
            } },
            /* @__PURE__ */ React.createElement(
              "span",
              { className: "auth-checkbox-box" + (remember ? " checked" : "") },
              remember && /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-check" }, "\u2713")
            ),
            "Keep me signed in on this device"
          ),
          /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Signing in\u2026" : "Sign in \u2192")
        )
      ),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-link-row" },
        /* @__PURE__ */ React.createElement("span", null, "New to Roma?"),
        /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signup") }, "Create an account \u2192")
      )
    );
  }
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
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        setError("Password must be at least 8 characters with 1 uppercase letter and 1 number.");
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(API + "/api/customer/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, first_name: firstName, last_name: lastName, newsletter })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          setError(data.error || "Registration failed.");
          setLoading(false);
          return;
        }
        onLogin(data.token, data.customer, true);
      } catch (e2) {
        setError("Unable to create account. Please try again.");
        setLoading(false);
      }
    };
    return /* @__PURE__ */ React.createElement(
      AuthPageShell,
      {
        goHome,
        panelImage: "https://plus.unsplash.com/premium_photo-1661902468735-eabf780f8ff6?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Marble \xB7 Luxury Bath",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "One account, ", /* @__PURE__ */ React.createElement("em", null, "two paths"), "."),
        panelSub: "If you\u2019re shopping for your own home, you\u2019ll be checking out in under a minute. If you\u2019re putting materials in other people\u2019s houses, the trade path unlocks pricing, a dedicated project manager, and the spec library."
      },
      /* @__PURE__ */ React.createElement(
        "div",
        null,
        /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Create your account"),
        /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Pick a path")
      ),
      error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
      /* @__PURE__ */ React.createElement(
        "div",
        { style: { display: "grid", gap: 10 } },
        /* @__PURE__ */ React.createElement(
          "label",
          { className: "auth-path-option" + (path === "homeowner" ? " selected" : ""), onClick: () => setPath("homeowner") },
          /* @__PURE__ */ React.createElement(
            "span",
            { className: "auth-path-radio" },
            path === "homeowner" && /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio-dot" })
          ),
          /* @__PURE__ */ React.createElement(
            "div",
            null,
            /* @__PURE__ */ React.createElement("div", { className: "auth-path-title" }, "Homeowner"),
            /* @__PURE__ */ React.createElement("div", { className: "auth-path-sub" }, "Shopping for your own home. 30-second sign-up.")
          ),
          /* @__PURE__ */ React.createElement("span", { className: "auth-path-tag", style: { color: "var(--gold)", borderColor: "rgba(168,121,53,0.33)" } }, "Fast")
        ),
        /* @__PURE__ */ React.createElement(
          "label",
          { className: "auth-path-option" + (path === "trade" ? " selected" : ""), onClick: () => setPath("trade") },
          /* @__PURE__ */ React.createElement(
            "span",
            { className: "auth-path-radio" },
            path === "trade" && /* @__PURE__ */ React.createElement("span", { className: "auth-path-radio-dot" })
          ),
          /* @__PURE__ */ React.createElement(
            "div",
            null,
            /* @__PURE__ */ React.createElement("div", { className: "auth-path-title" }, "Trade pro"),
            /* @__PURE__ */ React.createElement("div", { className: "auth-path-sub" }, "Designer, contractor, builder, installer. Goes through application.")
          ),
          /* @__PURE__ */ React.createElement("span", { className: "auth-path-tag", style: { color: "var(--warm-muted)", borderColor: "rgba(138,126,104,0.33)" } }, "Apply")
        )
      ),
      path === "homeowner" ? /* @__PURE__ */ React.createElement(
        React.Fragment,
        null,
        /* @__PURE__ */ React.createElement(GoogleSignInButton, { onCredentialResponse: handleGoogleCredential }),
        googleError && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, googleError),
        googleLoading && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", fontSize: "0.8125rem", color: "var(--stone-500)" } }, "Signing in with Google\u2026"),
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-divider" },
          /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" }),
          "or sign up with email",
          /* @__PURE__ */ React.createElement("span", { className: "auth-divider-line" })
        ),
        /* @__PURE__ */ React.createElement(
          "form",
          { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-field-2col" },
            /* @__PURE__ */ React.createElement(
              "div",
              { className: "auth-field" },
              /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "First name"),
              /* @__PURE__ */ React.createElement("input", { type: "text", value: firstName, onChange: (e) => setFirstName(e.target.value), placeholder: "First", required: true, autoComplete: "given-name" })
            ),
            /* @__PURE__ */ React.createElement(
              "div",
              { className: "auth-field" },
              /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Last name"),
              /* @__PURE__ */ React.createElement("input", { type: "text", value: lastName, onChange: (e) => setLastName(e.target.value), placeholder: "Last", required: true, autoComplete: "family-name" })
            )
          ),
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Email"),
            /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
          ),
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-field" },
            /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Password"),
            /* @__PURE__ */ React.createElement(
              "div",
              { className: "auth-field-row" },
              /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true, autoComplete: "new-password" }),
              /* @__PURE__ */ React.createElement("span", { className: "auth-field-hint" }, "8+ chars, 1 uppercase, 1 number")
            )
          ),
          /* @__PURE__ */ React.createElement(
            "div",
            { style: { display: "grid", gap: 14 } },
            /* @__PURE__ */ React.createElement(
              "label",
              { className: "auth-checkbox", onClick: (e) => {
                e.preventDefault();
                setNewsletter(!newsletter);
              } },
              /* @__PURE__ */ React.createElement(
                "span",
                { className: "auth-checkbox-box" + (newsletter ? " checked" : "") },
                newsletter && /* @__PURE__ */ React.createElement("span", { className: "auth-checkbox-check" }, "\u2713")
              ),
              /* @__PURE__ */ React.createElement("span", null, "Send me Roma\u2019s monthly field guide \u2014 install math, new arrivals, showroom notes. No daily emails. Unsubscribe whenever.")
            ),
            /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Creating account\u2026" : "Create my account \u2192"),
            /* @__PURE__ */ React.createElement(
              "div",
              { className: "auth-terms" },
              "By signing up you agree to Roma\u2019s ",
              /* @__PURE__ */ React.createElement("a", { href: "/terms", target: "_blank", rel: "noopener" }, "Terms of service"),
              " and acknowledge our ",
              /* @__PURE__ */ React.createElement("a", { href: "/privacy", target: "_blank", rel: "noopener" }, "privacy practices"),
              "."
            )
          )
        )
      ) : /* @__PURE__ */ React.createElement(
        "div",
        { style: { display: "grid", gap: 18, paddingTop: 12, borderTop: "0.5px solid rgba(28,25,23,0.13)" } },
        /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "The trade application takes about 5 minutes. You\u2019ll need your business license and a brief description of your work."),
        /* @__PURE__ */ React.createElement("button", { type: "button", className: "auth-cta", onClick: () => navigate("/trade") }, "Start trade application \u2192")
      ),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-link-row" },
        /* @__PURE__ */ React.createElement("span", null, "Already have an account?"),
        /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "Sign in \u2192")
      )
    );
  }
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
      if (newPassword !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
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
      } catch (e2) {
        setError("Something went wrong. Please try again.");
        setLoading(false);
      }
    };
    return /* @__PURE__ */ React.createElement(
      AuthPageShell,
      {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1659362549741-c32157cc71f4?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Colonnata \xB7 Massa-Carrara, Italy",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Your order is in. ", /* @__PURE__ */ React.createElement("em", null, "Now make it yours"), "."),
        panelSub: "Set a password to track your order, view invoices, reorder materials, and message your rep \u2014 all from one account."
      },
      /* @__PURE__ */ React.createElement(
        "div",
        null,
        /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Welcome to Roma"),
        /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Set your password")
      ),
      /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "Your account was created when you visited our showroom. Set a password to view your orders and manage your account online."),
      error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
      expired ? /* @__PURE__ */ React.createElement(
        "div",
        { style: { display: "grid", gap: 18 } },
        /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, "This link has expired. You can create a password by signing up with the same email address used for your order."),
        /* @__PURE__ */ React.createElement("button", { type: "button", className: "auth-cta", onClick: () => navigate("/signup") }, "Create account \u2192")
      ) : /* @__PURE__ */ React.createElement(
        "form",
        { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-field" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "New password"),
          /* @__PURE__ */ React.createElement("input", { type: "password", value: newPassword, onChange: (e) => setNewPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "new-password" })
        ),
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-field" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Confirm password"),
          /* @__PURE__ */ React.createElement("input", { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "new-password" })
        ),
        /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", margin: 0 } }, "8+ characters, 1 uppercase letter, 1 number"),
        /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading }, loading ? "Setting password\u2026" : "Set password \u2192")
      ),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-link-row" },
        /* @__PURE__ */ React.createElement("span", null, "Already have a password?"),
        /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "Sign in \u2192")
      )
    );
  }
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
        if (!res.ok || data.error) {
          setError(data.error || "Unable to send reset email.");
          setLoading(false);
          return;
        }
        setSent(true);
        setLoading(false);
      } catch (e2) {
        setError("Unable to send reset email. Please try again.");
        setLoading(false);
      }
    };
    return /* @__PURE__ */ React.createElement(
      AuthPageShell,
      {
        goHome,
        panelImage: "https://images.unsplash.com/photo-1661107259637-4e1c55462428?q=80&w=1471&auto=format&fit=crop",
        panelEyebrow: "Stone Tile \xB7 Modern Bath",
        panelHeadline: /* @__PURE__ */ React.createElement(React.Fragment, null, "Locked out? ", /* @__PURE__ */ React.createElement("em", null, "We\u2019ll send a link"), "."),
        panelSub: "Your cart, quotes, and project files stay safe in the meantime. The reset link expires in 30 minutes \u2014 if you don\u2019t see it, check the spam folder or write to Sales@romaflooringdesigns.com."
      },
      /* @__PURE__ */ React.createElement(
        "div",
        null,
        /* @__PURE__ */ React.createElement("div", { className: "auth-eyebrow" }, "Reset password"),
        /* @__PURE__ */ React.createElement("h1", { className: "auth-title" }, "Forgot it?", /* @__PURE__ */ React.createElement("br", null), "Happens.")
      ),
      /* @__PURE__ */ React.createElement("p", { className: "auth-subtitle" }, "Enter the email on your Roma account. We\u2019ll send a reset link that\u2019s good for 30 minutes."),
      error && /* @__PURE__ */ React.createElement("div", { className: "auth-error" }, error),
      /* @__PURE__ */ React.createElement(
        "form",
        { onSubmit: handleSubmit, style: { display: "grid", gap: 18 } },
        /* @__PURE__ */ React.createElement(
          "div",
          { className: "auth-field" },
          /* @__PURE__ */ React.createElement("div", { className: "auth-field-label" }, "Account email"),
          /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com", required: true, autoComplete: "email" })
        ),
        /* @__PURE__ */ React.createElement("button", { type: "submit", className: "auth-cta", disabled: loading || sent }, loading ? "Sending\u2026" : "Send reset link \u2192")
      ),
      sent && /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-confirm-banner" },
        /* @__PURE__ */ React.createElement("span", { className: "auth-confirm-icon" }, "\u2713"),
        /* @__PURE__ */ React.createElement(
          "div",
          null,
          /* @__PURE__ */ React.createElement("div", { className: "auth-confirm-title" }, "Reset link sent to " + email),
          /* @__PURE__ */ React.createElement(
            "div",
            { className: "auth-confirm-sub" },
            "Check your inbox. Didn\u2019t arrive within 5 minutes? ",
            /* @__PURE__ */ React.createElement("a", { onClick: () => {
              setSent(false);
              setLoading(false);
            } }, "Resend"),
            " or check spam."
          )
        )
      ),
      /* @__PURE__ */ React.createElement(
        "div",
        { className: "auth-link-row" },
        /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => navigate("/signin") }, "\u2190 Back to sign in"),
        /* @__PURE__ */ React.createElement("a", { className: "auth-link", onClick: () => window.location.href = "mailto:Sales@romaflooringdesigns.com" }, "Write to support \u2192")
      )
    );
  }
  function CustomerAuthModal({ onClose, onLogin, initialMode }) {
    const [mode, setMode] = useState(initialMode || "login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [loading, setLoading] = useState(false);
    const { handleGoogleCredential, googleError, googleLoading } = useGoogleAuth(onLogin);
    useEffect(() => {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }, []);
    const handleLogin = async (e) => {
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
          setError(data.error || "Login failed");
          setLoading(false);
          return;
        }
        onLogin(data.token, data.customer);
      } catch (e2) {
        setError("Login failed");
        setLoading(false);
      }
    };
    const handleRegister = async (e) => {
      e.preventDefault();
      setError("");
      setLoading(true);
      try {
        const res = await fetch(API + "/api/customer/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, first_name: firstName, last_name: lastName })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          setError(data.error || "Registration failed");
          setLoading(false);
          return;
        }
        onLogin(data.token, data.customer);
      } catch (e2) {
        setError("Registration failed");
        setLoading(false);
      }
    };
    const handleForgotPassword = async (e) => {
      e.preventDefault();
      setError("");
      setSuccess("");
      setLoading(true);
      try {
        const res = await fetch(API + "/api/customer/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          setError(data.error || "Unable to send reset email. Please try again.");
          setLoading(false);
          return;
        }
        setSuccess("If an account exists with that email, a reset link has been sent.");
        setLoading(false);
      } catch (e2) {
        setError("Unable to send reset email. Please try again.");
        setLoading(false);
      }
    };
    const switchMode = (newMode) => {
      setMode(newMode);
      setError("");
      setSuccess("");
    };
    return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal-content", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("h2", null, mode === "login" ? "Sign In" : mode === "register" ? "Create Account" : "Reset Password"), mode === "forgot" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Enter your email and we'll send you a link to reset your password."), /* @__PURE__ */ React.createElement("form", { onSubmit: handleForgotPassword }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), success && /* @__PURE__ */ React.createElement("div", { style: { padding: "0.75rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4, fontSize: "0.875rem", color: "#166534", marginBottom: "1rem" } }, success), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" }, disabled: loading || !!success }, loading ? "..." : "Send Reset Link")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginTop: "1.5rem", fontSize: "0.875rem" } }, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      switchMode("login");
    }, style: { color: "var(--gold)", cursor: "pointer" } }, "Back to Sign In"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, mode === "login" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(GoogleSignInButton, { onCredentialResponse: handleGoogleCredential }), googleError && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, googleError), googleLoading && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Signing in with Google\u2026"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, margin: "1rem 0", fontSize: "0.8125rem", color: "var(--stone-400)" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1, borderBottom: "1px solid var(--stone-200)" } }), "or", /* @__PURE__ */ React.createElement("span", { style: { flex: 1, borderBottom: "1px solid var(--stone-200)" } }))), /* @__PURE__ */ React.createElement("form", { onSubmit: mode === "login" ? handleLogin : handleRegister }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), mode === "register" && /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "First Name"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: firstName, onChange: (e) => setFirstName(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Last Name"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: lastName, onChange: (e) => setLastName(e.target.value), required: true }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Password"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true })), mode === "login" && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      switchMode("forgot");
    }, style: { fontSize: "0.8125rem", color: "var(--gold)", cursor: "pointer" } }, "Forgot password?")), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" }, disabled: loading }, loading ? "..." : mode === "login" ? "Sign In" : "Create Account")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginTop: "1.5rem", fontSize: "0.875rem" } }, mode === "login" ? /* @__PURE__ */ React.createElement("span", null, "No account? ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      switchMode("register");
    }, style: { color: "var(--gold)", cursor: "pointer" } }, "Create one")) : /* @__PURE__ */ React.createElement("span", null, "Have an account? ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      switchMode("login");
    }, style: { color: "var(--gold)", cursor: "pointer" } }, "Sign in"))))));
  }
  function InstallationModal({ onClose, product }) {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [zipCode, setZipCode] = useState("");
    const [sqft, setSqft] = useState("");
    const [message, setMessage] = useState("");
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }, []);
    const handleSubmit = async (e) => {
      e.preventDefault();
      setError("");
      try {
        const body = { customer_name: name, customer_email: email, phone, zip_code: zipCode, estimated_sqft: sqft || null, message };
        if (product) {
          body.product_id = product.product_id;
          body.sku_id = product.sku_id;
          body.product_name = product.product_name;
          body.collection = product.collection;
        }
        const res = await fetch(API + "/api/installation-inquiries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.error) {
          setError(data.error);
          return;
        }
        setSubmitted(true);
      } catch (e2) {
        setError("Unable to submit. Please try again.");
      }
    };
    return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal-content", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "\xD7"), submitted ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "2rem 0" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, borderRadius: "50%", background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.5rem" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "#059669", strokeWidth: "2", style: { width: 30, height: 30 } }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h2", { style: { marginBottom: "0.5rem" } }, "Thank You!"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.95rem" } }, "We'll be in touch within 1 business day.")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "Request Installation Quote"), product && /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.875rem", marginBottom: "1.5rem" } }, "For: ", fullProductName(product)), /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Name *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: name, onChange: (e) => setName(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "tel", value: phone, onChange: (e) => setPhone(e.target.value), required: true }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "ZIP Code"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: zipCode, onChange: (e) => setZipCode(e.target.value), maxLength: 5 })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Est. Square Feet"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "number", value: sqft, onChange: (e) => setSqft(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Message"), /* @__PURE__ */ React.createElement("textarea", { className: "checkout-input", value: message, onChange: (e) => setMessage(e.target.value), rows: 3, style: { resize: "vertical" } })), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" } }, "Submit Inquiry")))));
  }
  function InstallationPage({ onRequestQuote }) {
    return /* @__PURE__ */ React.createElement("div", { className: "installation-page" }, /* @__PURE__ */ React.createElement("div", { className: "install-hero" }, /* @__PURE__ */ React.createElement("h1", null, "Professional Installation"), /* @__PURE__ */ React.createElement("p", null, "Licensed and insured installers with decades of combined experience. From hardwood to tile, we ensure a flawless finish on every project."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onRequestQuote }, "Request a Free Quote")), /* @__PURE__ */ React.createElement("div", { className: "install-types" }, /* @__PURE__ */ React.createElement("h2", null, "What We Install"), /* @__PURE__ */ React.createElement("div", { className: "install-types-grid" }, /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" })), /* @__PURE__ */ React.createElement("h3", null, "Hardwood"), /* @__PURE__ */ React.createElement("p", null, "Solid and engineered hardwood installation with precision nailing, glue-down, or floating methods.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "3", x2: "12", y2: "21" })), /* @__PURE__ */ React.createElement("h3", null, "Tile & Porcelain"), /* @__PURE__ */ React.createElement("p", null, "Floor and wall tile installation including mortar-set, large-format, and mosaic applications.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M2 20h20" }), /* @__PURE__ */ React.createElement("path", { d: "M4 20V8l4-4h8l4 4v12" }), /* @__PURE__ */ React.createElement("path", { d: "M2 20l4-4" }), /* @__PURE__ */ React.createElement("path", { d: "M22 20l-4-4" })), /* @__PURE__ */ React.createElement("h3", null, "Luxury Vinyl"), /* @__PURE__ */ React.createElement("p", null, "Click-lock LVP and glue-down LVT for waterproof, durable performance in any room.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2L2 7l10 5 10-5-10-5z" }), /* @__PURE__ */ React.createElement("path", { d: "M2 17l10 5 10-5" }), /* @__PURE__ */ React.createElement("path", { d: "M2 12l10 5 10-5" })), /* @__PURE__ */ React.createElement("h3", null, "Natural Stone"), /* @__PURE__ */ React.createElement("p", null, "Marble, travertine, slate, and quartzite installed with expert care for lasting beauty.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M4 20c0-4 4-4 4-8s-4-4-4-8" }), /* @__PURE__ */ React.createElement("path", { d: "M12 20c0-4 4-4 4-8s-4-4-4-8" }), /* @__PURE__ */ React.createElement("path", { d: "M20 20c0-4 4-4 4-8s-4-4-4-8" })), /* @__PURE__ */ React.createElement("h3", null, "Carpet"), /* @__PURE__ */ React.createElement("p", null, "Stretch-in and direct-glue carpet installation for bedrooms, living spaces, and commercial areas.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "6", width: "20", height: "12", rx: "1" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "10", y1: "6", x2: "10", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "14", y1: "6", x2: "14", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "18", y2: "18" })), /* @__PURE__ */ React.createElement("h3", null, "Laminate"), /* @__PURE__ */ React.createElement("p", null, "Quick and affordable floating-floor laminate installation with seamless transitions.")))), /* @__PURE__ */ React.createElement("div", { className: "install-steps-section" }, /* @__PURE__ */ React.createElement("h2", null, "How It Works"), /* @__PURE__ */ React.createElement("div", { className: "install-steps" }, /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "1"), /* @__PURE__ */ React.createElement("h3", null, "Request a Quote"), /* @__PURE__ */ React.createElement("p", null, "Tell us about your project \u2014 flooring type, square footage, and timeline.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "2"), /* @__PURE__ */ React.createElement("h3", null, "Site Visit & Measure"), /* @__PURE__ */ React.createElement("p", null, "Our team visits your space for precise measurements and subfloor assessment.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "3"), /* @__PURE__ */ React.createElement("h3", null, "Schedule Installation"), /* @__PURE__ */ React.createElement("p", null, "Pick a date that works for you. We handle materials, prep, and cleanup.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "4"), /* @__PURE__ */ React.createElement("h3", null, "Enjoy Your New Floors"), /* @__PURE__ */ React.createElement("p", null, "Walk-through inspection, care instructions, and warranty documentation provided.")))), /* @__PURE__ */ React.createElement("div", { className: "install-benefits" }, /* @__PURE__ */ React.createElement("h2", null, "Why Choose Us"), /* @__PURE__ */ React.createElement("div", { className: "install-benefits-grid" }, /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" })), /* @__PURE__ */ React.createElement("h3", null, "Licensed & Insured"), /* @__PURE__ */ React.createElement("p", null, "California Contractor License #830966. Fully bonded and insured for your protection.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "8", r: "7" }), /* @__PURE__ */ React.createElement("polyline", { points: "8.21 13.89 7 23 12 20 17 23 15.79 13.88" })), /* @__PURE__ */ React.createElement("h3", null, "Manufacturer Certified"), /* @__PURE__ */ React.createElement("p", null, "Factory-trained installers certified by leading flooring manufacturers.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" })), /* @__PURE__ */ React.createElement("h3", null, "Warranty Included"), /* @__PURE__ */ React.createElement("p", null, "Every installation backed by our workmanship warranty for your peace of mind.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" })), /* @__PURE__ */ React.createElement("h3", null, "Free Estimates"), /* @__PURE__ */ React.createElement("p", null, "No-obligation quotes with transparent pricing. No hidden fees, ever.")))), /* @__PURE__ */ React.createElement("div", { className: "install-area" }, /* @__PURE__ */ React.createElement("h2", null, "Service Area"), /* @__PURE__ */ React.createElement("p", null, "We proudly serve Orange County and surrounding areas, including:"), /* @__PURE__ */ React.createElement("p", { className: "install-area-cities" }, "Anaheim \xB7 Fullerton \xB7 Irvine \xB7 Orange \xB7 Tustin \xB7 Santa Ana \xB7 Yorba Linda \xB7 Placentia \xB7 Brea \xB7 Buena Park \xB7 Huntington Beach \xB7 Costa Mesa \xB7 Newport Beach \xB7 Mission Viejo \xB7 Lake Forest \xB7 Laguna Hills")), /* @__PURE__ */ React.createElement("div", { className: "install-cta-band" }, /* @__PURE__ */ React.createElement("h2", null, "Ready to Get Started?"), /* @__PURE__ */ React.createElement("p", null, "Request a free, no-obligation quote and let our experts transform your space."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onRequestQuote }, "Request a Free Quote")));
  }
  function SalePage({ onSkuClick, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku, navigate }) {
    const [skus, setSkus] = useState([]);
    const [loading, setLoading] = useState(true);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [sortBy, setSortBy] = useState("discount");
    const [stats, setStats] = useState({ count: 0, max_discount: 0 });
    const limit = 24;
    useEffect(() => {
      fetch("/api/storefront/sale/stats").then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => setStats(data)).catch(() => {
      });
    }, []);
    useEffect(() => {
      setLoading(true);
      const offset = (page - 1) * limit;
      fetch(`/api/storefront/skus?sale=true&sort=${sortBy}&limit=${limit}&offset=${offset}`).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then((data) => {
        setSkus(data.skus || []);
        setTotal(data.total || 0);
        setLoading(false);
      }).catch(() => setLoading(false));
    }, [page, sortBy]);
    const totalPages = Math.ceil(total / limit);
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "sale-hero" }, /* @__PURE__ */ React.createElement("div", { className: "sale-hero-badge" }, "LIMITED TIME"), /* @__PURE__ */ React.createElement("h1", null, "Sale"), /* @__PURE__ */ React.createElement("p", null, "Exceptional flooring at extraordinary prices. Shop our curated selection of premium materials at reduced prices."), stats.count > 0 && /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stats" }, /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stat" }, /* @__PURE__ */ React.createElement("div", { className: "stat-value" }, stats.count), /* @__PURE__ */ React.createElement("div", { className: "stat-label" }, "Products on Sale")), /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stat" }, /* @__PURE__ */ React.createElement("div", { className: "stat-value" }, "Up to ", stats.max_discount, "%"), /* @__PURE__ */ React.createElement("div", { className: "stat-label" }, "Savings")))), /* @__PURE__ */ React.createElement("div", { className: "sale-grid-section" }, loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "sale-empty" }, /* @__PURE__ */ React.createElement("h2", null, "No sale items right now"), /* @__PURE__ */ React.createElement("p", null, "Check back soon \u2014 we regularly add new deals on premium flooring."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => navigate("/shop") }, "Browse All Products")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sale-toolbar" }, /* @__PURE__ */ React.createElement("span", { className: "result-count" }, total, " product", total !== 1 ? "s" : "", " on sale"), /* @__PURE__ */ React.createElement("select", { value: sortBy, onChange: (e) => {
      setSortBy(e.target.value);
      setPage(1);
    } }, /* @__PURE__ */ React.createElement("option", { value: "discount" }, "Biggest Savings"), /* @__PURE__ */ React.createElement("option", { value: "price_asc" }, "Price: Low to High"), /* @__PURE__ */ React.createElement("option", { value: "price_desc" }, "Price: High to Low"), /* @__PURE__ */ React.createElement("option", { value: "newest" }, "Newest"), /* @__PURE__ */ React.createElement("option", { value: "name_asc" }, "Name: A\u2013Z"))), /* @__PURE__ */ React.createElement(SkuGrid, { skus, onSkuClick, wishlist, toggleWishlist: toggleWishlist2, setQuickViewSku }), totalPages > 1 && /* @__PURE__ */ React.createElement(Pagination, { currentPage: page, totalPages, onPageChange: (p) => {
      setPage(p);
      window.scrollTo(0, 400);
    } }))), /* @__PURE__ */ React.createElement("div", { className: "sale-cta-band" }, /* @__PURE__ */ React.createElement("h2", null, "Need Help Choosing?"), /* @__PURE__ */ React.createElement("p", null, "Our flooring experts are here to help you find the perfect material for your project."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-outline-light", onClick: () => navigate("/installation") }, "Get a Free Consultation")));
  }
  function InspirationPage({ navigate, goBrowse }) {
    const rooms = [
      { name: "Kitchen", slug: "kitchen", desc: "Durable, beautiful floors for the heart of your home.", gradient: "linear-gradient(135deg, #c9a668 0%, #a8967a 50%, #78716c 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "9", x2: "21", y2: "9" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "9", x2: "9", y2: "21" })) },
      { name: "Living Room", slug: "living-room", desc: "Warm, inviting surfaces for everyday living.", gradient: "linear-gradient(135deg, #8a9a7b 0%, #a8967a 50%, #78716c 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v3" }), /* @__PURE__ */ React.createElement("path", { d: "M2 11v6a2 2 0 002 2h16a2 2 0 002-2v-6a2 2 0 00-4 0H6a2 2 0 00-4 0z" }), /* @__PURE__ */ React.createElement("path", { d: "M4 19v2" }), /* @__PURE__ */ React.createElement("path", { d: "M20 19v2" })) },
      { name: "Bathroom", slug: "bathroom", desc: "Waterproof elegance for wet spaces.", gradient: "linear-gradient(135deg, #94a3b8 0%, #a8a29e 50%, #78716c 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M4 12h16a1 1 0 011 1v3a4 4 0 01-4 4H7a4 4 0 01-4-4v-3a1 1 0 011-1z" }), /* @__PURE__ */ React.createElement("path", { d: "M6 12V5a2 2 0 012-2h1" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "1" })) },
      { name: "Bedroom", slug: "bedroom", desc: "Soft, quiet comfort underfoot.", gradient: "linear-gradient(135deg, #c4a882 0%, #b8a898 50%, #a8a29e 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M2 16V6a2 2 0 012-2h16a2 2 0 012 2v10" }), /* @__PURE__ */ React.createElement("path", { d: "M2 12h20" }), /* @__PURE__ */ React.createElement("path", { d: "M2 16h20v2H2z" }), /* @__PURE__ */ React.createElement("path", { d: "M6 12V8h12v4" })) },
      { name: "Dining Room", slug: "dining-room", desc: "Refined surfaces for memorable gatherings.", gradient: "linear-gradient(135deg, #b8942e 0%, #c9a668 50%, #a8967a 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2v8" }), /* @__PURE__ */ React.createElement("path", { d: "M8 6c0-1.5 1.8-4 4-4s4 2.5 4 4-1.8 4-4 4-4-2.5-4-4z" }), /* @__PURE__ */ React.createElement("path", { d: "M12 10v12" }), /* @__PURE__ */ React.createElement("path", { d: "M8 22h8" })) },
      { name: "Entryway", slug: "entryway", desc: "Make a lasting first impression.", gradient: "linear-gradient(135deg, #a8967a 0%, #d6d3d1 50%, #a8a29e 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 21h18" }), /* @__PURE__ */ React.createElement("path", { d: "M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16" }), /* @__PURE__ */ React.createElement("rect", { x: "9", y: "9", width: "6", height: "12" }), /* @__PURE__ */ React.createElement("circle", { cx: "14", cy: "15", r: "1" })) },
      { name: "Outdoor", slug: "outdoor", desc: "Weather-resistant style for patios and decks.", gradient: "linear-gradient(135deg, #6b8f5e 0%, #8a9a7b 50%, #a8a29e 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2L2 7l10 5 10-5-10-5z" }), /* @__PURE__ */ React.createElement("path", { d: "M2 17l10 5 10-5" }), /* @__PURE__ */ React.createElement("path", { d: "M2 12l10 5 10-5" })) },
      { name: "Laundry Room", slug: "laundry-room", desc: "Practical, easy-clean flooring solutions.", gradient: "linear-gradient(135deg, #93c5e8 0%, #a8b8c8 50%, #a8a29e 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "2", width: "20", height: "20", rx: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "13", r: "5" }), /* @__PURE__ */ React.createElement("path", { d: "M12 8v1" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "5", r: "1" })) }
    ];
    const tips = [
      { title: "Start with Your Lifestyle", text: "Consider how each room is used daily. High-traffic areas need durable materials like porcelain or luxury vinyl, while bedrooms can embrace softer options like carpet or cork.", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" })) },
      { title: "Consider the Light", text: "Natural light affects how flooring colors appear. Lighter floors open up darker rooms, while rich tones add warmth to sun-filled spaces. Always view samples in your actual room lighting.", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "5" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "1", x2: "12", y2: "3" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "21", x2: "12", y2: "23" }), /* @__PURE__ */ React.createElement("line", { x1: "4.22", y1: "4.22", x2: "5.64", y2: "5.64" }), /* @__PURE__ */ React.createElement("line", { x1: "18.36", y1: "18.36", x2: "19.78", y2: "19.78" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "12", x2: "3", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "12", x2: "23", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "4.22", y1: "19.78", x2: "5.64", y2: "18.36" }), /* @__PURE__ */ React.createElement("line", { x1: "18.36", y1: "5.64", x2: "19.78", y2: "4.22" })) },
      { title: "Think About Flow", text: "Create visual continuity by using complementary flooring throughout your home. Similar tones across rooms create a cohesive look, while transitions mark distinct living zones.", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("polyline", { points: "22 12 18 12 15 21 9 3 6 12 2 12" })) }
    ];
    const styles = [
      { name: "Modern Minimalist", slug: "modern-minimalist", desc: "Clean lines, neutral tones, and understated elegance.", gradient: "linear-gradient(135deg, #e7e5e4 0%, #a8a29e 50%, #78716c 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" })) },
      { name: "Warm Mediterranean", slug: "warm-mediterranean", desc: "Terracotta warmth and rustic character.", gradient: "linear-gradient(135deg, #c9a668 0%, #c4856c 50%, #a8967a 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("path", { d: "M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20" }), /* @__PURE__ */ React.createElement("line", { x1: "2", y1: "12", x2: "22", y2: "12" })) },
      { name: "Coastal Retreat", slug: "coastal-retreat", desc: "Light, airy floors inspired by the shore.", gradient: "linear-gradient(135deg, #bfdbfe 0%, #94a3b8 50%, #e7e5e4 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0" }), /* @__PURE__ */ React.createElement("path", { d: "M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" }), /* @__PURE__ */ React.createElement("path", { d: "M2 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0" })) },
      { name: "Classic Elegance", slug: "classic-elegance", desc: "Timeless patterns and rich natural materials.", gradient: "linear-gradient(135deg, #44403c 0%, #78716c 50%, #c9a668 100%)", icon: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" })) }
    ];
    return /* @__PURE__ */ React.createElement("div", { className: "inspiration-page" }, /* @__PURE__ */ React.createElement("div", { className: "inspo-hero" }, /* @__PURE__ */ React.createElement("h1", null, "Find Your Inspiration"), /* @__PURE__ */ React.createElement("p", null, "Explore room ideas, design tips, and curated styles to help you envision the perfect floor for every space in your home."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: goBrowse }, "Browse All Products")), /* @__PURE__ */ React.createElement("div", { className: "inspo-section" }, /* @__PURE__ */ React.createElement("h2", null, "Browse by Room"), /* @__PURE__ */ React.createElement("p", { className: "inspo-section-sub" }, "Select a room to explore flooring options tailored to that space."), /* @__PURE__ */ React.createElement("div", { className: "inspo-rooms-grid" }, rooms.map((r) => /* @__PURE__ */ React.createElement("div", { key: r.slug, className: "inspo-room-card", style: { background: r.gradient }, onClick: () => navigate("/shop?room=" + r.slug) }, /* @__PURE__ */ React.createElement("div", { className: "inspo-room-icon" }, r.icon), /* @__PURE__ */ React.createElement("h3", null, r.name), /* @__PURE__ */ React.createElement("p", null, r.desc))))), /* @__PURE__ */ React.createElement("div", { className: "inspo-tips" }, /* @__PURE__ */ React.createElement("h2", null, "Design Tips"), /* @__PURE__ */ React.createElement("p", { className: "inspo-section-sub" }, "Expert guidance to help you choose with confidence."), /* @__PURE__ */ React.createElement("div", { className: "inspo-tips-grid" }, tips.map((t) => /* @__PURE__ */ React.createElement("div", { key: t.title, className: "inspo-tip-card" }, /* @__PURE__ */ React.createElement("div", { className: "inspo-tip-icon" }, t.icon), /* @__PURE__ */ React.createElement("h3", null, t.title), /* @__PURE__ */ React.createElement("p", null, t.text))))), /* @__PURE__ */ React.createElement("div", { className: "inspo-section" }, /* @__PURE__ */ React.createElement("h2", null, "Popular Styles"), /* @__PURE__ */ React.createElement("p", { className: "inspo-section-sub" }, "Shop curated collections inspired by trending design aesthetics."), /* @__PURE__ */ React.createElement("div", { className: "inspo-styles-grid" }, styles.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.slug, className: "inspo-style-card", style: { background: s.gradient }, onClick: () => navigate("/shop?collection=" + s.slug) }, /* @__PURE__ */ React.createElement("div", { className: "inspo-style-icon" }, s.icon), /* @__PURE__ */ React.createElement("h3", null, s.name), /* @__PURE__ */ React.createElement("p", null, s.desc))))), /* @__PURE__ */ React.createElement("div", { className: "inspo-cta-band" }, /* @__PURE__ */ React.createElement("h2", null, "Ready to Transform Your Space?"), /* @__PURE__ */ React.createElement("p", null, "Explore our full catalog or request free samples to see and feel the difference."), /* @__PURE__ */ React.createElement("div", { className: "inspo-cta-buttons" }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: goBrowse }, "Browse All Products"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", style: { borderColor: "rgba(255,255,255,0.3)", color: "white" }, onClick: () => navigate("/shop?sort=newest") }, "Order Free Samples"))));
  }
  function TradePage({ goTradeDashboard, onApplyClick, tradeCustomer }) {
    return /* @__PURE__ */ React.createElement("div", { className: "trade-page" }, /* @__PURE__ */ React.createElement("div", { className: "trade-hero" }, /* @__PURE__ */ React.createElement("h1", null, "Trade Program"), /* @__PURE__ */ React.createElement("p", null, "Exclusive pricing, dedicated support, and streamlined ordering for industry professionals."), tradeCustomer ? /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: goTradeDashboard }, "Go to Dashboard") : /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onApplyClick }, "Apply Now")), /* @__PURE__ */ React.createElement("div", { className: "trade-benefits" }, /* @__PURE__ */ React.createElement("h2", null, "Why Join?"), /* @__PURE__ */ React.createElement("div", { className: "trade-benefits-grid" }, /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" })), /* @__PURE__ */ React.createElement("h3", null, "Trade Pricing"), /* @__PURE__ */ React.createElement("p", null, "Access exclusive wholesale pricing on our full catalog of premium flooring and surfaces.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" })), /* @__PURE__ */ React.createElement("h3", null, "Dedicated Rep"), /* @__PURE__ */ React.createElement("p", null, "Work with a dedicated sales representative who understands your business needs.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "3", width: "15", height: "13" }), /* @__PURE__ */ React.createElement("polygon", { points: "16 8 20 8 23 11 23 16 16 16 16 8" }), /* @__PURE__ */ React.createElement("circle", { cx: "5.5", cy: "18.5", r: "2.5" }), /* @__PURE__ */ React.createElement("circle", { cx: "18.5", cy: "18.5", r: "2.5" })), /* @__PURE__ */ React.createElement("h3", null, "Bulk Ordering"), /* @__PURE__ */ React.createElement("p", null, "Streamlined bulk ordering with SKU-based entry and project tracking.")))), /* @__PURE__ */ React.createElement("div", { className: "trade-how-it-works" }, /* @__PURE__ */ React.createElement("h2", null, "How It Works"), /* @__PURE__ */ React.createElement("div", { className: "trade-steps" }, /* @__PURE__ */ React.createElement("div", { className: "trade-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "1"), /* @__PURE__ */ React.createElement("h3", null, "Apply Online"), /* @__PURE__ */ React.createElement("p", null, "Submit your business credentials and verification documents.")), /* @__PURE__ */ React.createElement("div", { className: "trade-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "2"), /* @__PURE__ */ React.createElement("h3", null, "Get Approved"), /* @__PURE__ */ React.createElement("p", null, "Our team reviews your application within 1-2 business days.")), /* @__PURE__ */ React.createElement("div", { className: "trade-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "3"), /* @__PURE__ */ React.createElement("h3", null, "Start Saving"), /* @__PURE__ */ React.createElement("p", null, "Access trade pricing, bulk orders, and your dedicated dashboard.")))), /* @__PURE__ */ React.createElement("div", { className: "trade-tiers" }, /* @__PURE__ */ React.createElement("h2", null, "Membership Tiers"), /* @__PURE__ */ React.createElement("div", { className: "trade-tiers-grid" }, /* @__PURE__ */ React.createElement("div", { className: "tier-card" }, /* @__PURE__ */ React.createElement("div", { className: "tier-name" }, "Silver"), /* @__PURE__ */ React.createElement("div", { className: "tier-discount" }, "10%"), /* @__PURE__ */ React.createElement("div", { className: "tier-threshold" }, "Entry tier"), /* @__PURE__ */ React.createElement("ul", null, /* @__PURE__ */ React.createElement("li", null, "Trade pricing on all products"), /* @__PURE__ */ React.createElement("li", null, "Dedicated sales rep"), /* @__PURE__ */ React.createElement("li", null, "Project tracking"))), /* @__PURE__ */ React.createElement("div", { className: "tier-card featured" }, /* @__PURE__ */ React.createElement("div", { className: "tier-name" }, "Gold"), /* @__PURE__ */ React.createElement("div", { className: "tier-discount" }, "15%"), /* @__PURE__ */ React.createElement("div", { className: "tier-threshold" }, "$25,000+ annual"), /* @__PURE__ */ React.createElement("ul", null, /* @__PURE__ */ React.createElement("li", null, "Everything in Silver"), /* @__PURE__ */ React.createElement("li", null, "Priority fulfillment"), /* @__PURE__ */ React.createElement("li", null, "Extended payment terms"))), /* @__PURE__ */ React.createElement("div", { className: "tier-card" }, /* @__PURE__ */ React.createElement("div", { className: "tier-name" }, "Platinum"), /* @__PURE__ */ React.createElement("div", { className: "tier-discount" }, "20%"), /* @__PURE__ */ React.createElement("div", { className: "tier-threshold" }, "$75,000+ annual"), /* @__PURE__ */ React.createElement("ul", null, /* @__PURE__ */ React.createElement("li", null, "Everything in Gold"), /* @__PURE__ */ React.createElement("li", null, "Custom quotes"), /* @__PURE__ */ React.createElement("li", null, "Job site delivery"))))), /* @__PURE__ */ React.createElement("div", { className: "trade-cta-section" }, /* @__PURE__ */ React.createElement("h2", null, "Ready to Get Started?"), /* @__PURE__ */ React.createElement("p", null, "Join hundreds of contractors, designers, and builders who trust Roma Flooring Designs."), /* @__PURE__ */ React.createElement("div", { className: "trade-cta-buttons" }, tradeCustomer ? /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: goTradeDashboard }, "Go to Dashboard") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onApplyClick }, "Apply Now"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", style: { borderColor: "rgba(255,255,255,0.3)", color: "white" }, onClick: onApplyClick }, "Sign In")))));
  }
  function BulkOrderPage({ tradeToken, addToCart, goTradeDashboard, showToast }) {
    const [rows, setRows] = useState([{ sku_code: "", quantity: "" }]);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const updateRow = (idx, field, value) => {
      setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
    };
    const addRow = () => setRows((prev) => [...prev, { sku_code: "", quantity: "" }]);
    const removeRow = (idx) => setRows((prev) => prev.filter((_, i) => i !== idx));
    const validateOrder = async () => {
      setError("");
      setLoading(true);
      const items = rows.filter((r) => r.sku_code.trim() && r.quantity).map((r) => ({ sku_code: r.sku_code.trim(), quantity: parseInt(r.quantity) }));
      if (items.length === 0) {
        setError("Add at least one item.");
        setLoading(false);
        return;
      }
      try {
        const resp = await fetch(API + "/api/trade/bulk-order", {
          method: "POST",
          headers: { "X-Trade-Token": tradeToken, "Content-Type": "application/json" },
          body: JSON.stringify({ items })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data.error || "Validation failed");
          setLoading(false);
          return;
        }
        setPreview(data);
      } catch (err) {
        setError("Network error.");
      }
      setLoading(false);
    };
    const confirmOrder = async () => {
      setLoading(true);
      try {
        const resp = await fetch(API + "/api/trade/bulk-order/confirm", {
          method: "POST",
          headers: { "X-Trade-Token": tradeToken, "Content-Type": "application/json" },
          body: JSON.stringify({ items: preview.validated_items })
        });
        const data = await resp.json();
        if (!resp.ok) {
          setError(data.error);
          setLoading(false);
          return;
        }
        showToast("Bulk order placed successfully!", "success");
        goTradeDashboard();
      } catch (err) {
        setError("Failed to place order.");
      }
      setLoading(false);
    };
    return /* @__PURE__ */ React.createElement("div", { className: "trade-dashboard" }, /* @__PURE__ */ React.createElement("div", { className: "trade-dash-header" }, /* @__PURE__ */ React.createElement("h1", null, "Bulk Order"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: goTradeDashboard }, "Back to Dashboard")), error && /* @__PURE__ */ React.createElement("div", { className: "trade-msg trade-msg-error" }, error), !preview ? /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-500)", marginBottom: "1.5rem" } }, "Enter SKU codes and quantities. Click Validate to check availability and pricing."), /* @__PURE__ */ React.createElement("table", { className: "bulk-order-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "SKU Code"), /* @__PURE__ */ React.createElement("th", { style: { width: 120 } }, "Quantity"), /* @__PURE__ */ React.createElement("th", { style: { width: 40 } }))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((r, i) => /* @__PURE__ */ React.createElement("tr", { key: i }, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { value: r.sku_code, onChange: (e) => updateRow(i, "sku_code", e.target.value), placeholder: "e.g. FLR-OAK-001" })), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", value: r.quantity, onChange: (e) => updateRow(i, "quantity", e.target.value), placeholder: "Qty" })), /* @__PURE__ */ React.createElement("td", null, rows.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "remove-btn", onClick: () => removeRow(i) }, "\xD7")))))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.75rem", marginTop: "1rem" } }, /* @__PURE__ */ React.createElement("button", { onClick: addRow, style: { background: "none", border: "1px dashed var(--stone-300)", padding: "0.5rem 1rem", cursor: "pointer", fontSize: "0.8125rem", color: "var(--stone-500)" } }, "+ Add Row"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: validateOrder, disabled: loading }, loading ? "Validating..." : "Validate Order"))) : /* @__PURE__ */ React.createElement("div", { className: "trade-card" }, /* @__PURE__ */ React.createElement("h3", null, "Order Preview"), /* @__PURE__ */ React.createElement("table", { className: "trade-orders-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "SKU"), /* @__PURE__ */ React.createElement("th", null, "Product"), /* @__PURE__ */ React.createElement("th", null, "Qty"), /* @__PURE__ */ React.createElement("th", null, "Unit Price"), /* @__PURE__ */ React.createElement("th", null, "Subtotal"))), /* @__PURE__ */ React.createElement("tbody", null, preview.validated_items.map((item, i) => /* @__PURE__ */ React.createElement("tr", { key: i }, /* @__PURE__ */ React.createElement("td", { style: { fontWeight: 500 } }, item.sku_code), /* @__PURE__ */ React.createElement("td", null, item.product_name), /* @__PURE__ */ React.createElement("td", null, item.quantity), /* @__PURE__ */ React.createElement("td", null, "$", parseFloat(item.unit_price).toFixed(2)), /* @__PURE__ */ React.createElement("td", null, "$", parseFloat(item.subtotal).toFixed(2)))))), preview.errors && preview.errors.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1rem" } }, preview.errors.map((err, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "trade-msg trade-msg-error" }, err))), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right", marginTop: "1rem", fontSize: "1.125rem", fontWeight: 500 } }, "Total: $", parseFloat(preview.total || 0).toFixed(2)), /* @__PURE__ */ React.createElement("div", { className: "trade-btn-row", style: { marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "trade-btn-secondary", onClick: () => setPreview(null) }, "Edit"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: confirmOrder, disabled: loading }, loading ? "Placing Order..." : "Place Order"))));
  }
  function VisitRecapPage({ token, onSkuClick }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    useEffect(() => {
      fetch(API + "/api/visit-recap/" + token).then((r) => {
        if (r.status === 410) throw new Error("expired");
        if (!r.ok) throw new Error("not_found");
        return r.json();
      }).then((d) => {
        setData(d);
        setLoading(false);
      }).catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    }, [token]);
    if (loading) return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 800, margin: "4rem auto", padding: "0 1.5rem", textAlign: "center" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)" } }, "Loading your visit recap..."));
    if (error) return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 800, margin: "4rem auto", padding: "0 1.5rem", textAlign: "center" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "2rem", fontWeight: 400, marginBottom: "1rem" } }, error === "expired" ? "Recap Expired" : "Not Found"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "1rem" } }, error === "expired" ? "This visit recap has expired." : "This recap could not be found."), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.875rem", marginTop: "1.5rem" } }, "Questions? Contact us at (714) 999-0009"));
    const { visit, items } = data;
    const visitDate = new Date(visit.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 900, margin: "0 auto", padding: "3rem 1.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginBottom: "3rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontSize: "2.5rem", fontWeight: 400, marginBottom: "0.5rem" } }, "Your Showroom Visit"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.9375rem" } }, "Prepared by ", visit.rep_name, " \xB7 ", visitDate)), visit.message && /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "0 auto 3rem", padding: "1.5rem 2rem", background: "var(--stone-50)", borderLeft: "3px solid var(--gold)" } }, /* @__PURE__ */ React.createElement("p", { style: { margin: 0, fontSize: "0.9375rem", color: "var(--stone-600)", fontStyle: "italic", lineHeight: 1.6 } }, visit.message)), /* @__PURE__ */ React.createElement("div", { className: "sku-grid", style: { marginBottom: "3rem" } }, items.map((item, idx) => /* @__PURE__ */ React.createElement(
      "div",
      {
        key: item.id || idx,
        className: "sku-card",
        style: { cursor: item.sku_id ? "pointer" : "default" },
        onClick: () => item.sku_id && onSkuClick(item.sku_id, item.product_name)
      },
      /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, item.primary_image && /* @__PURE__ */ React.createElement("img", { onLoad: handleProductImgLoad, src: optimizeImg(item.primary_image, 400), alt: item.product_name, loading: "lazy", decoding: "async" })),
      /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, fullProductName(item)),
      /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, skuListPrice(item) ? "$" + displayPrice(item, skuListPrice(item)).toFixed(2) + priceSuffix(item) : ""),
      item.rep_note && /* @__PURE__ */ React.createElement("p", { style: { margin: "0.5rem 0 0", fontSize: "0.8125rem", fontStyle: "italic", color: "var(--stone-400)", lineHeight: 1.4 } }, '"', item.rep_note, '"')
    ))), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", paddingTop: "2rem", borderTop: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem", marginBottom: "0.25rem" } }, "Questions? Contact us at (714) 999-0009"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.8125rem" } }, "Roma Flooring Designs \xB7 1440 S. State College Blvd Suite 6M, Anaheim, CA 92806")));
  }
  function ResetPasswordPage({ goHome, openLogin, onLogin }) {
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);
    const token = new URLSearchParams(window.location.search).get("reset_token");
    const handleSubmit = async (e) => {
      e.preventDefault();
      setError("");
      if (newPassword !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
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
          setError(data.error || "Something went wrong.");
          setLoading(false);
          return;
        }
        setSuccess(true);
        window.history.replaceState({}, "", window.location.pathname);
        if (data.token && data.customer && onLogin) {
          onLogin(data.token, data.customer, true);
          return;
        }
      } catch (e2) {
        setError("Something went wrong.");
      }
      setLoading(false);
    };
    return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 440, margin: "4rem auto", padding: "0 1.5rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontSize: "2rem", fontWeight: 400, marginBottom: "1.5rem", textAlign: "center" } }, "Reset Your Password"), success ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "1rem", marginBottom: "1.5rem", fontSize: "0.875rem" } }, "Your password has been reset successfully."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
      goHome();
      setTimeout(openLogin, 100);
    } }, "Sign In")) : /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "New Password"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: newPassword, onChange: (e) => setNewPassword(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Confirm New Password"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), required: true })), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginBottom: "1rem" } }, "8+ characters, 1 uppercase letter, 1 number"), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, disabled: loading }, loading ? "Resetting..." : "Reset Password")));
  }
  function ToastContainer({ toasts }) {
    if (toasts.length === 0) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "toast-container" }, toasts.map((t) => /* @__PURE__ */ React.createElement("div", { key: t.id, className: `toast toast-${t.type}${t.leaving ? " toast-leaving" : ""}` }, t.type === "success" && /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", width: "18", height: "18" }, /* @__PURE__ */ React.createElement("path", { d: "M20 6L9 17l-5-5" })), t.type === "error" && /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", width: "18", height: "18" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "15", y1: "9", x2: "9", y2: "15" }), /* @__PURE__ */ React.createElement("line", { x1: "9", y1: "9", x2: "15", y2: "15" })), t.type === "info" && /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", width: "18", height: "18" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "16", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "8", x2: "12.01", y2: "8" })), /* @__PURE__ */ React.createElement("span", null, t.message))));
  }
  function BackToTop() {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
      const onScroll = () => setVisible(window.scrollY > 600);
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }, []);
    if (!visible) return null;
    return /* @__PURE__ */ React.createElement("button", { className: "back-to-top", onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }), "aria-label": "Back to top" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", width: "20", height: "20" }, /* @__PURE__ */ React.createElement("polyline", { points: "18 15 12 9 6 15" })));
  }
  function Breadcrumbs({ items }) {
    return /* @__PURE__ */ React.createElement("nav", { className: "breadcrumbs", "aria-label": "Breadcrumb" }, items.map((item, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, i > 0 && /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, "/"), item.onClick ? /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      item.onClick();
    } }, item.label) : /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-800)" } }, item.label))));
  }
  function CookieConsent({ navigate }) {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
      try {
        if (!localStorage.getItem("cookie_consent")) setVisible(true);
      } catch (e) {
      }
      const reopen = () => setVisible(true);
      window.addEventListener("open-cookie-preferences", reopen);
      return () => window.removeEventListener("open-cookie-preferences", reopen);
    }, []);
    const choose = (choice) => {
      try {
        localStorage.setItem("cookie_consent", choice);
        localStorage.setItem("cookie_consent_at", (/* @__PURE__ */ new Date()).toISOString());
      } catch (e) {
      }
      try {
        window.dispatchEvent(new CustomEvent("cookie-consent", { detail: choice }));
      } catch (e) {
      }
      setVisible(false);
    };
    if (!visible) return null;
    return /* @__PURE__ */ React.createElement("div", { role: "dialog", "aria-label": "Cookie notice", style: {
      position: "fixed",
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 1e4,
      background: "var(--stone-900)",
      color: "var(--stone-50)",
      padding: "1.125rem 1.25rem",
      boxShadow: "0 -4px 28px rgba(0,0,0,0.22)"
    } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1rem 1.5rem", maxWidth: 1200, margin: "0 auto" } }, /* @__PURE__ */ React.createElement("p", { style: { flex: "1 1 300px", margin: 0, fontSize: "0.8125rem", lineHeight: 1.55, color: "rgba(250,250,249,0.85)" } }, "We use cookies to keep your cart and session working, remember your preferences, and understand how our site is used. By clicking \u201CAccept,\u201D you agree to this use. You can decline non-essential cookies at any time. See our", " ", /* @__PURE__ */ React.createElement("a", { href: "/privacy", onClick: (e) => {
      e.preventDefault();
      if (navigate) navigate("/privacy");
    }, style: { color: "var(--gold-light)", textDecoration: "underline" } }, "Privacy Policy"), "."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.625rem", flexShrink: 0 } }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => choose("declined"), style: {
      padding: "0.625rem 1.25rem",
      background: "transparent",
      color: "var(--stone-50)",
      border: "0.5px solid rgba(250,250,249,0.35)",
      borderRadius: 4,
      cursor: "pointer",
      fontFamily: "var(--font-body)",
      fontSize: "0.8125rem",
      fontWeight: 500
    } }, "Decline"), /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => choose("accepted"), style: {
      padding: "0.625rem 1.5rem",
      background: "var(--gold)",
      color: "var(--stone-900)",
      border: "none",
      borderRadius: 4,
      cursor: "pointer",
      fontFamily: "var(--font-body)",
      fontSize: "0.8125rem",
      fontWeight: 600
    } }, "Accept"))));
  }
  function LegalPage({ kind, goHome, navigate }) {
    const isTerms = kind === "terms";
    const title = { terms: "Terms of Service", privacy: "Privacy Policy", accessibility: "Accessibility Statement" }[kind] || "Legal";
    const relHref = kind === "privacy" ? "/terms" : "/privacy";
    const relLabel = kind === "privacy" ? "Terms of Service" : "Privacy Policy";
    const termsSections = [
      { h: "1. Acceptance of Terms", p: "By accessing this site, requesting a quote, or placing an order with Roma Flooring Designs (\u201CRoma,\u201D \u201Cwe,\u201D or \u201Cus\u201D), you acknowledge that you have read, understood, and agree to be bound by these Terms of Service. These Terms govern every sale and take precedence over any conflicting terms in your purchase documents unless we expressly agree otherwise in writing. If you do not agree, please do not use this site or purchase from us." },
      { h: "2. Natural Materials & Variation", p: "Stone, tile, wood, and other natural or nature-derived products are products of nature. Variation in color, veining, shade, tone, texture, finish, size, and marking is normal, inherent to the material, and to be expected \u2014 it is a characteristic of natural products, not a defect. Samples, displays, and on-screen images are representative only and are not guaranteed to match production material exactly. Roma does not warrant that any material will match a sample, prior lot, photograph, or expectation of uniformity, and such variation is never a basis for a claim, return, or refund." },
      { h: "3. Pricing & Quotes", p: "Prices, promotions, availability, coverage figures, and specifications are subject to change at Roma\u2019s sole discretion and may be corrected at any time, including after an order is submitted, in the event of pricing or typographical error. Quotes and estimates are valid only for the period stated on them or, if none is stated, for such period as Roma determines, and are subject to material availability, current lot pricing, and final measurement. Flooring is generally sold by the square foot and accessories by the unit, with coverage rounded up to full cartons or boxes." },
      { h: "4. Orders & Acceptance", p: "Your submission of an order is an offer to purchase. All orders are subject to acceptance by Roma, and Roma may accept, decline, limit, modify, or cancel any order, in whole or in part, at its sole discretion \u2014 including for suspected error, material unavailability, or quantity limits. No order is binding on Roma until accepted and, where applicable, paid." },
      { h: "5. Payment & Taxes", p: "Payment is processed through our third-party payment providers; by paying with a card, Klarna, or another offered method you also agree to that provider\u2019s terms. Roma may require a deposit or full payment in advance, particularly for special, custom, or freight orders, on terms determined at Roma\u2019s discretion. Applicable California sales tax is calculated at checkout. Title to and risk of loss for all materials pass to you upon delivery or pickup." },
      { h: "6. Inspection Before Installation", p: "You are responsible for inspecting all materials before installation. Prior to installing, cutting, or otherwise using any product, you must verify quantity, color, shade, lot, size, quality, and overall condition, and confirm the material is acceptable and suitable for its intended use. Installation, cutting, or use of any material constitutes your final acceptance of it in its delivered condition. Do not install material you believe to be incorrect or unacceptable \u2014 contact us first." },
      { h: "7. All Sales Final \u2014 No Returns or Exchanges", p: "ALL SALES ARE FINAL. Materials are sold without returns, exchanges, refunds, or cancellations. Special-order, custom, cut, closeout, and clearance items are in all cases non-returnable and non-refundable. Any exception is granted solely at Roma\u2019s discretion, in writing, and may be conditioned on the material being unopened and in resalable condition and on payment of restocking, handling, and freight charges as Roma determines." },
      { h: "8. No Claims After Installation", p: "NO CLAIMS AFTER INSTALLATION. Once material has been installed, cut, or used, it is deemed inspected, accepted, and satisfactory, and Roma assumes NO responsibility for color, shade, quality, size, or other variation, or for any claim of any kind relating to that material. Roma is not responsible for material that is installed after a visible or discoverable concern, nor for labor, installation, removal, replacement, or related costs. Claims, if any are permitted at all, must be raised before installation." },
      { h: "9. Shipping, Freight & Pickup", p: "Freight-shipped orders are quoted based on destination and scheduled after the order is placed; delivery dates are estimates and are not guaranteed. You are responsible for confirming site access and for measuring for delivery, and for inspecting shipments for visible damage or shortage at the time of delivery. Showroom pickup is available at our Anaheim location; uncollected material may be subject to storage fees at Roma\u2019s discretion. Title and risk of loss pass to you upon delivery or pickup." },
      { h: "10. Cancellations & Special Orders", p: "Orders may be cancelled only with Roma\u2019s written consent and at Roma\u2019s discretion. Special, custom, and non-stock orders are placed on your behalf and are non-cancellable and non-refundable once submitted to the vendor. Where a cancellation is permitted, it may be subject to restocking, handling, and freight charges and to forfeiture of deposits, as determined by Roma." },
      { h: "11. Warranties & Disclaimer", p: "Manufactured products may carry the applicable manufacturer\u2019s warranty, which is provided by the manufacturer and not by Roma; any warranty claim is subject to that manufacturer\u2019s terms and process. Except for any express written warranty provided by Roma, all products and services are furnished \u201CAS IS\u201D and \u201CWITH ALL FAULTS,\u201D and Roma disclaims all other warranties, express or implied, including any implied warranty of merchantability or fitness for a particular purpose, to the fullest extent permitted by law." },
      { h: "12. Limitation of Liability", p: "To the maximum extent permitted by law, Roma\u2019s total liability arising out of or relating to any product, order, or these Terms shall not exceed the amount actually paid to Roma for the specific product giving rise to the claim, and Roma shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, labor, installation, removal, replacement, or delay costs, even if advised of the possibility of such damages. Roma is not responsible for installation performed by you or by any third party." },
      { h: "13. Trade Program", p: "Trade accounts, trade pricing, and payment terms are offered at Roma\u2019s discretion and are subject to eligibility verification, program terms, and any applicable membership terms in effect. Roma may modify, suspend, or terminate a trade account or its benefits at any time at its discretion." },
      { h: "14. Governing Law", p: "These Terms and any sale are governed by the laws of the State of California, without regard to its conflict-of-laws rules. The exclusive venue for any dispute shall be the state or federal courts located in Orange County, California, and you consent to their jurisdiction. If any provision of these Terms is found unenforceable, the remaining provisions remain in full force and effect." },
      { h: "15. Changes to These Terms", p: "Roma may revise these Terms at any time at its discretion by posting an updated version. The Terms in effect at the time of your order govern that order. Your continued use of this site or purchase from Roma constitutes acceptance of the then-current Terms." },
      { h: "16. Contact", p: "Questions about these Terms? Contact us using the details below." }
    ];
    const privacySections = [
      { h: "1. Overview", p: "This Privacy Policy explains how Roma Flooring Designs (\u201CRoma,\u201D \u201Cwe,\u201D or \u201Cus\u201D) collects, uses, and shares information when you visit this site, create an account, request a sample or quote, place an order, or otherwise interact with us. By using this site or purchasing from us, you consent to the practices described here. This policy applies to our online storefront and related services and does not govern any third party\u2019s site or service." },
      { h: "2. Information You Provide", p: "We collect information you give us directly \u2014 for example your name, email address, phone number, billing and shipping addresses, order and sample-request history, account login credentials, project details, and any messages you send us. If you apply to our trade program, we may also collect business information and verification documents such as your business name, resale certificate, EIN, and contractor license." },
      { h: "3. Information Collected Automatically", p: "When you use the site we automatically collect certain technical and usage information, such as your device and browser type, IP address, pages viewed, products and quotes you interact with, referring pages, and a cart or session identifier. We use cookies, local storage, and similar technologies to keep your cart and session working, remember preferences and recently viewed items, and measure how the site is used." },
      { h: "4. Payment Information", p: "Payments are processed by our third-party payment providers (such as Stripe and Klarna). Full payment card numbers are entered with and handled by those providers and are not stored on our servers; we may retain limited, non-sensitive details such as the card brand and last four digits, a processor customer or payment token, and transaction status to service your order, process refunds, and prevent fraud. Your use of a payment provider is also subject to that provider\u2019s own terms and privacy policy." },
      { h: "5. How We Use Information", p: "We use information to process, fulfill, and deliver orders and samples; create and manage accounts; verify and administer trade accounts; provide customer support; send transactional messages such as order, account, and shipping notifications; operate, secure, and improve the site and our products and services; measure engagement and analytics; detect and prevent fraud or misuse; and comply with legal obligations. With your consent where required, or as otherwise permitted, we may also send marketing or promotional communications, which you can opt out of at any time." },
      { h: "6. How We Share Information", p: "We share information as needed to run the business \u2014 for example with service providers that host our systems, process payments, deliver shipments, fulfill orders through our vendors, send email, and provide analytics \u2014 each of whom is permitted to use the information only to perform services for us. We may also disclose information to comply with law, enforce our agreements, protect the rights, safety, and property of Roma or others, or in connection with a merger, acquisition, financing, or sale of assets. We do not sell your personal information." },
      { h: "7. Cookies & Your Choices", p: "Most browsers let you refuse or delete cookies through their settings; note that disabling cookies may affect cart, checkout, and other features. You may unsubscribe from marketing emails using the link in those messages or by contacting us; we may still send you non-promotional, transactional messages about your orders and account." },
      { h: "8. Data Retention", p: "We retain information for as long as needed to provide our services, maintain your account and order records, resolve disputes, and comply with our legal, tax, and accounting obligations, and otherwise as determined by Roma. When information is no longer needed, we take reasonable steps to delete or de-identify it." },
      { h: "9. Data Security", p: "We use reasonable, industry-standard safeguards \u2014 including encryption in transit \u2014 designed to protect information under our control. No method of transmission or storage is completely secure, however, and we cannot guarantee absolute security. You are responsible for keeping your account credentials confidential." },
      { h: "10. Your Rights", p: "You may access or update your account information by signing in, or request access, correction, or deletion of your personal information by contacting us. Depending on where you live, you may have additional rights under applicable law. California residents may, subject to the California Consumer Privacy Act as amended, request to know the personal information we have collected, request its deletion or correction, and opt out of any \u201Csale\u201D or \u201Csharing\u201D of personal information \u2014 noting that we do not sell personal information \u2014 and will not be discriminated against for exercising these rights. We may need to verify your identity before acting on a request." },
      { h: "11. Children\u2019s Privacy", p: "This site is intended for adults and is not directed to children. We do not knowingly collect personal information from children under 16. If you believe a child has provided us information, please contact us and we will take appropriate steps to delete it." },
      { h: "12. Third-Party Links", p: "Our site may link to third-party websites or services that we do not control. We are not responsible for the privacy practices or content of those third parties, and we encourage you to review their policies." },
      { h: "13. Changes to This Policy", p: "We may update this Privacy Policy from time to time at our discretion. Changes are effective when the updated policy is posted, and your continued use of the site or purchase from Roma constitutes acceptance of the then-current policy." },
      { h: "14. Contact", p: "Questions about your privacy or this policy? Contact us using the details below." }
    ];
    const accessibilitySections = [
      { h: "1. Our Commitment", p: "Roma Flooring Designs is committed to making our website and our Anaheim showroom accessible to everyone, including people with disabilities, and to providing a welcoming, usable experience for all of our customers." },
      { h: "2. Conformance Goal", p: "We aim to align this website with the Web Content Accessibility Guidelines (WCAG) 2.1, Level AA \u2014 the widely recognized standard for web accessibility. Accessibility is an ongoing effort, and we continue to review and improve the experience over time." },
      { h: "3. What We Do", p: "We consider accessibility as we design and build the site \u2014 for example readable typography and color contrast, descriptive text for meaningful images, keyboard-navigable controls, clear and consistent layouts, and labeled forms \u2014 and we work to improve these areas as the site evolves." },
      { h: "4. Assistive Technology & Compatibility", p: "We aim for the site to work with current browsers and commonly used assistive technologies such as screen readers and screen-magnification tools. Because technology and content change frequently, some features may perform best with the latest versions of your browser and assistive software." },
      { h: "5. Third-Party Content", p: "Some content and tools on our site are provided by third parties (for example payment, mapping, or embedded media). We do not control the accessibility of third-party content, but we select our providers with care and welcome your feedback about any barriers you encounter." },
      { h: "6. Help & Alternative Access", p: "If any part of our site is difficult to use, our team is glad to help. You can reach our Anaheim showroom during business hours for product information, to request samples or quotes, and to place orders with a team member \u2014 so you never have to complete a purchase online to work with us." },
      { h: "7. Feedback & Contact", p: "We welcome your feedback on the accessibility of this site. If you encounter a barrier, or need assistance or a reasonable accommodation, please contact us using the details below and we will do our best to help and to address the issue. Letting us know the page and the difficulty you experienced helps us respond effectively." }
    ];
    const sections = { terms: termsSections, privacy: privacySections, accessibility: accessibilitySections }[kind] || [];
    return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 760, margin: "3.5rem auto 5rem", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.6875rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--stone-500)", marginBottom: "0.75rem" } }, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, fontSize: "2.75rem", lineHeight: 1.1, margin: "0 0 0.5rem" } }, title), /* @__PURE__ */ React.createElement("div", { style: { color: "var(--stone-500)", fontSize: "0.875rem", marginBottom: "2rem" } }, "Effective date: July 17, 2026"), sections.map((s, i) => /* @__PURE__ */ React.createElement("section", { key: i, style: { marginBottom: "1.75rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "1.0625rem", margin: "0 0 0.5rem", color: "var(--stone-800)" } }, s.h), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.9375rem", lineHeight: 1.65, margin: 0 } }, s.p))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2.5rem", paddingTop: "1.5rem", borderTop: "0.5px solid rgba(28,25,23,0.13)", color: "var(--stone-600)", fontSize: "0.875rem", lineHeight: 1.7 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, color: "var(--stone-800)" } }, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("div", null, "1440 South State College Blvd #6M, Anaheim, CA 92806"), /* @__PURE__ */ React.createElement("div", null, "License #830966 \xB7 (714) 999-0009")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2rem", display: "flex", gap: "1.25rem", fontSize: "0.875rem" } }, /* @__PURE__ */ React.createElement("a", { href: relHref, onClick: (e) => {
      e.preventDefault();
      navigate(relHref);
    }, style: { color: "var(--stone-700)", textDecoration: "underline" } }, relLabel), /* @__PURE__ */ React.createElement("a", { href: "/", onClick: (e) => {
      e.preventDefault();
      goHome();
    }, style: { color: "var(--stone-700)", textDecoration: "underline" } }, "Back to home")));
  }
  const ABOUT_FACTS = {
    address: "1440 S. State College Blvd #6M",
    cityzip: "Anaheim, CA 92806",
    phone: "(714) 999-0009",
    phoneHref: "tel:+17149990009",
    license: "License #830966",
    mapsUrl: "https://maps.google.com/?q=1440+S+State+College+Blvd+%236M,+Anaheim,+CA+92806"
  };
  const ABOUT_VALUES = [
    { t: "Stand on it first", d: "No floor goes home on a screen alone. Every material in our showroom can be held, walked on, and cut to a sample at the counter before you commit a single dollar." },
    { t: "Stone outlives trends", d: "We stock what lasts thirty years, not one season. If a material will not age well in a Californian house, it does not earn a place on our floor." },
    { t: "A person answers the phone", d: "When something comes up mid-install, you reach a person who was here when the order was written \u2014 not a queue. That has been true since the first day." },
    { t: "One roof, every trade", d: "Flooring, stone, tile, and cabinets under one roof, supplied and set by people who talk to each other. One number to call when a room needs to come together." }
  ];
  function AboutImgSlot({ label, ratio = "4 / 3" }) {
    const ink = "#1c1917";
    return /* @__PURE__ */ React.createElement("div", { style: {
      aspectRatio: ratio,
      width: "100%",
      background: "#ddd4c1",
      border: `1px solid ${ink}20`,
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden"
    } }, /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 10, border: `1px dashed ${ink}26`, pointerEvents: "none" } }), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: 20 } }, /* @__PURE__ */ React.createElement("svg", { width: "26", height: "26", viewBox: "0 0 24 24", fill: "none", stroke: ink + "66", strokeWidth: "1.2", style: { marginBottom: 10 }, "aria-hidden": "true" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "1" }), /* @__PURE__ */ React.createElement("circle", { cx: "8.5", cy: "8.5", r: "1.6" }), /* @__PURE__ */ React.createElement("path", { d: "M21 15l-5-5L5 21" })), /* @__PURE__ */ React.createElement("div", { style: { font: "500 10px/1.5 var(--font-body)", letterSpacing: "0.18em", textTransform: "uppercase", color: ink + "88" } }, label)));
  }
  function AboutPage({ navigate }) {
    const INK = "#1c1917";
    const PAPER = "#efe9dc";
    const PAPER_ALT = "#e9e3d6";
    const ACCENT = "var(--gold)";
    return /* @__PURE__ */ React.createElement("div", { className: "about-page", style: { background: PAPER, color: INK } }, /* @__PURE__ */ React.createElement("section", { style: { maxWidth: 720, margin: "0 auto", padding: "clamp(64px, 9vw, 112px) 32px 64px", textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1.8 var(--font-body)", letterSpacing: "0.22em", textTransform: "uppercase", color: ACCENT, marginBottom: 30 } }, "A family flooring house \xB7 Anaheim, California"), /* @__PURE__ */ React.createElement("h1", { style: { margin: 0, fontFamily: "var(--font-heading)", fontWeight: 400, fontSize: "clamp(2.125rem, 5vw, 3rem)", lineHeight: 1.3, letterSpacing: "0.004em", textWrap: "balance" } }, "We have spent fifteen years learning what a good floor asks of a house \u2014 and then keeping that material on the shelf.")), /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 720, margin: "0 auto", padding: "0 32px" } }, /* @__PURE__ */ React.createElement("div", { style: { height: 1, background: `${INK}22` } })), /* @__PURE__ */ React.createElement("section", { style: { maxWidth: 640, margin: "0 auto", padding: "64px 32px 40px" } }, /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1 var(--font-body)", letterSpacing: "0.24em", textTransform: "uppercase", color: `${INK}88`, marginBottom: 32 } }, "A note from the family"), /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 26px", font: "400 19px/1.85 var(--font-heading)", textWrap: "pretty" } }, /* @__PURE__ */ React.createElement("span", { style: { float: "left", font: "400 76px/0.78 var(--font-heading)", color: ACCENT, padding: "6px 14px 0 0" } }, "R"), "oma began in 2010 with a single rented bay, a tile saw, and a simple rule: never sell a floor you would not lay in your own home. We started with the materials other shops would not bother to stock, and a habit of walking customers across every sample until they were sure."), /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 26px", font: "400 17px/1.92 var(--font-body)", color: `${INK}cc`, textWrap: "pretty" } }, "Fifteen years later the saw is still here, and so are we. The bay became a showroom; the odd lots became a real collection of hardwood, stone, tile, and cabinetry. What did not change is the counter \u2014 the place where someone on our team will still cut you a sample, talk you out of the wrong choice, and answer the phone when the install hits a surprise."), /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 38px", font: "400 17px/1.92 var(--font-body)", color: `${INK}cc`, textWrap: "pretty" } }, "We are not the biggest flooring company in Orange County, and we have never tried to be. We would rather be the one a family comes back to for the second house, and sends their neighbor to for the first. A few things we hold to, in case it helps you decide whether we are your kind of shop:"), /* @__PURE__ */ React.createElement("ol", { style: { margin: "0 0 42px", padding: 0, listStyle: "none" } }, ABOUT_VALUES.map((v, i) => /* @__PURE__ */ React.createElement("li", { key: i, style: { display: "flex", gap: 22, padding: "22px 0", borderTop: `1px solid ${INK}1a` } }, /* @__PURE__ */ React.createElement("span", { style: { font: "400 26px/1 var(--font-heading)", fontStyle: "italic", color: ACCENT, flex: "0 0 auto", width: 34 } }, String(i + 1).padStart(2, "0")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 17px/1.4 var(--font-heading)", marginBottom: 7 } }, v.t), /* @__PURE__ */ React.createElement("p", { style: { margin: 0, font: "400 15px/1.78 var(--font-body)", color: `${INK}aa`, textWrap: "pretty" } }, v.d))))), /* @__PURE__ */ React.createElement("div", { style: { borderTop: `1px solid ${INK}1a`, paddingTop: 30 } }, /* @__PURE__ */ React.createElement("p", { style: { margin: "0 0 18px", font: "400 17px/1.85 var(--font-body)", color: `${INK}cc` } }, "Come stand on a few. We will put the kettle on."), /* @__PURE__ */ React.createElement("div", { style: { font: "400 34px/1 var(--font-heading)", fontStyle: "italic", color: INK, marginBottom: 8 } }, "The Roma family"), /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1.6 var(--font-body)", letterSpacing: "0.16em", textTransform: "uppercase", color: `${INK}77` } }, "Founders \xB7 Anaheim, California"))), /* @__PURE__ */ React.createElement("section", { style: { maxWidth: 720, margin: "0 auto", padding: "20px 32px 72px" } }, /* @__PURE__ */ React.createElement(AboutImgSlot, { label: "The showroom counter", ratio: "16 / 7" }), /* @__PURE__ */ React.createElement("div", { style: { font: "400 12px/1.6 var(--font-body)", color: `${INK}77`, marginTop: 12, fontStyle: "italic" } }, "Fig. \u2014 the counter at our Anaheim showroom, much as it looks today.")), /* @__PURE__ */ React.createElement("section", { style: { background: PAPER_ALT, borderTop: `1px solid ${INK}22` } }, /* @__PURE__ */ React.createElement("div", { className: "about-visit-grid", style: { maxWidth: 720, margin: "0 auto", padding: "64px 32px" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { font: "500 11px/1 var(--font-body)", letterSpacing: "0.24em", textTransform: "uppercase", color: ACCENT, marginBottom: 22 } }, "Visit the showroom"), /* @__PURE__ */ React.createElement("div", { style: { font: "400 22px/1.5 var(--font-heading)", marginBottom: 18 } }, ABOUT_FACTS.address, /* @__PURE__ */ React.createElement("br", null), ABOUT_FACTS.cityzip), /* @__PURE__ */ React.createElement("div", { style: { font: "400 14px/1.9 var(--font-body)", color: `${INK}aa` } }, "Mon \u2013 Fri \xB7 9am \u2013 5pm", /* @__PURE__ */ React.createElement("br", null), "Saturday \xB7 10am \u2013 5pm", /* @__PURE__ */ React.createElement("br", null), "Closed Sunday", /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("a", { href: ABOUT_FACTS.phoneHref, style: { color: "inherit", textDecoration: "none" } }, ABOUT_FACTS.phone), /* @__PURE__ */ React.createElement("br", null), ABOUT_FACTS.license, /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("span", { style: { fontStyle: "italic" } }, "Just off the 57 freeway."))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("a", { href: ABOUT_FACTS.mapsUrl, target: "_blank", rel: "noopener noreferrer", style: { display: "block", textDecoration: "none", color: "inherit" }, "aria-label": "Open our showroom location in Google Maps" }, /* @__PURE__ */ React.createElement(AboutImgSlot, { label: "Open in Google Maps", ratio: "4 / 3" })), /* @__PURE__ */ React.createElement("a", { href: ABOUT_FACTS.phoneHref, style: {
      display: "inline-block",
      marginTop: 18,
      font: "500 11px/1 var(--font-body)",
      letterSpacing: "0.18em",
      textTransform: "uppercase",
      color: INK,
      textDecoration: "none",
      cursor: "pointer",
      borderBottom: `1px solid ${INK}`,
      paddingBottom: 6
    } }, "Book a counter visit")))));
  }
  function SiteFooter({ goHome, goBrowse, goCollections, goTrade, onInstallClick, navigate }) {
    return /* @__PURE__ */ React.createElement("div", { className: "footer" }, /* @__PURE__ */ React.createElement("div", { className: "footer-inner" }, /* @__PURE__ */ React.createElement("div", { className: "footer-brand" }, /* @__PURE__ */ React.createElement("h3", null, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("p", null, "Premium flooring, tile, stone, and countertop products. Curated collections for designers, builders, and homeowners since 2010.")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Shop"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goBrowse();
    } }, "All Products"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goCollections();
    } }, "Collections"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      navigate("/shop?new=1");
    } }, "New Arrivals"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      navigate("/shop?sale=1");
    } }, "Sale")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Services"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      onInstallClick && onInstallClick();
    } }, "Installation"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      navigate("/shop");
    } }, "Design Consultation"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      navigate("/shop");
    } }, "Room Visualizer"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      navigate("/shop");
    } }, "Free Samples")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Trade"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goTrade();
    } }, "Trade Program"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goTrade();
    } }, "Apply Now"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      goTrade();
    } }, "Trade Login")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Visit"), /* @__PURE__ */ React.createElement("div", { className: "footer-visit-detail" }, "1440 S. State College Blvd Suite 6M", /* @__PURE__ */ React.createElement("br", null), "Anaheim, CA 92806", /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("br", null), "Mon\u2013Fri 9am\u20135pm", /* @__PURE__ */ React.createElement("br", null), "Sat 10am\u20135pm", /* @__PURE__ */ React.createElement("br", null), "Sun Closed", /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("a", { href: "tel:+17149990009" }, "(714) 999-0009"), /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("a", { href: "mailto:Sales@romaflooringdesigns.com" }, "Sales@romaflooringdesigns.com")))), /* @__PURE__ */ React.createElement("div", { className: "footer-bottom" }, "\xA9 2026 Roma Flooring Designs. All rights reserved. License #830966", /* @__PURE__ */ React.createElement("div", { className: "footer-bottom-links" }, /* @__PURE__ */ React.createElement("a", { href: "/privacy", onClick: (e) => {
      e.preventDefault();
      navigate("/privacy");
    } }, "Privacy"), /* @__PURE__ */ React.createElement("span", null, "|"), /* @__PURE__ */ React.createElement("a", { href: "/terms", onClick: (e) => {
      e.preventDefault();
      navigate("/terms");
    } }, "Terms"), /* @__PURE__ */ React.createElement("span", null, "|"), /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (e) => {
      e.preventDefault();
      try {
        window.dispatchEvent(new Event("open-cookie-preferences"));
      } catch (err) {
      }
    } }, "Cookie preferences"), /* @__PURE__ */ React.createElement("span", null, "|"), /* @__PURE__ */ React.createElement("a", { href: "/accessibility", onClick: (e) => {
      e.preventDefault();
      navigate("/accessibility");
    } }, "Accessibility"))));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(ErrorBoundary, null, /* @__PURE__ */ React.createElement(StorefrontApp, null)));
})();
