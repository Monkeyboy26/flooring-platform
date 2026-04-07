const { useState, useEffect, useRef, useCallback, useMemo } = React;
const API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:3001" : `${window.location.protocol}//${window.location.hostname}:3001`;
function getSessionId() {
  let id = localStorage.getItem("cart_session_id");
  if (!id) {
    id = "sess_" + crypto.randomUUID();
    localStorage.setItem("cart_session_id", id);
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
    if (el && value) el.setAttribute("content", value);
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
  return sku.sell_by === "unit";
}
function isSoldPerSqyd(sku) {
  if (!sku) return false;
  return sku.sell_by === "sqyd" || sku.price_basis === "per_sqyd";
}
function isCarpet(sku) {
  return sku && sku.cut_price != null;
}
function carpetSqftPrice(sqydPrice) {
  return (parseFloat(sqydPrice) / 9).toFixed(2);
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
  if (isSoldPerUnit(sku)) return "/ea";
  if (isSoldPerSqyd(sku)) return "/sqyd";
  return "/sqft";
}
function displayPrice(sku, rawPrice) {
  const price = parseFloat(rawPrice || 0);
  if (sku && sku.sell_by === "unit" && (sku.price_basis === "sqft" || sku.price_basis === "per_sqft") && parseFloat(sku.sqft_per_box) > 0) {
    return price * parseFloat(sku.sqft_per_box);
  }
  if (sku && sku.sell_by === "sqft" && sku.price_basis === "per_unit" && parseFloat(sku.sqft_per_box) > 0 && parseFloat(sku.pieces_per_box) > 0) {
    return price / (parseFloat(sku.sqft_per_box) / parseFloat(sku.pieces_per_box));
  }
  return price;
}
function thumbUrl(url, w, h) {
  if (!url || typeof url !== "string") return url;
  if (url.endsWith(".svg")) return url;
  let params = `url=${encodeURIComponent(url)}&w=${w || 400}&f=auto`;
  if (h) params += `&h=${h}`;
  return `/api/img?${params}`;
}
var optimizeImg = thumbUrl;
const PLACEHOLDER_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'%3E%3Crect fill='%23f5f0eb' width='400' height='400'/%3E%3Cg transform='translate(150,140)' opacity='0.3'%3E%3Crect x='10' y='10' width='80' height='80' rx='8' fill='none' stroke='%23a0937d' stroke-width='3'/%3E%3Ccircle cx='35' cy='35' r='8' fill='none' stroke='%23a0937d' stroke-width='3'/%3E%3Cpath d='M90 70L65 45 30 90' fill='none' stroke='%23a0937d' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/g%3E%3C/svg%3E";
function handleImgError(e) {
  if (!e.target.dataset.fallback) {
    e.target.dataset.fallback = "1";
    e.target.src = PLACEHOLDER_SVG;
  }
}
document.addEventListener("error", function(e) {
  if (e.target.tagName === "IMG" && !e.target.dataset.fallback) {
    e.target.dataset.fallback = "1";
    e.target.src = PLACEHOLDER_SVG;
  }
}, true);
const RECENT_SEARCHES_KEY = "roma_recent_searches";
const MAX_RECENT_SEARCHES = 6;
function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]");
  } catch {
    return [];
  }
}
function addRecentSearch(term) {
  if (!term || term.length < 2) return;
  const recent = getRecentSearches().filter((t) => t.toLowerCase() !== term.toLowerCase());
  recent.unshift(term);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES)));
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
    return parts.map((part, i) => regex.test(part) ? React.createElement("mark", { key: i, className: "search-highlight" }, part) : part);
  } catch {
    return text;
  }
}
const COLOR_HEX_MAP = {
  "White": "#ffffff",
  "Bright White": "#f8f8ff",
  "Glossy White": "#f5f5f5",
  "Ivory": "#fffff0",
  "Cream": "#fffdd0",
  "Beige": "#f5f0e1",
  "Tan": "#d2b48c",
  "Sand": "#c2b280",
  "Taupe": "#a89080",
  "Brown": "#6b4226",
  "Dark Brown": "#3e2723",
  "Chocolate": "#3e1c00",
  "Espresso": "#3c1414",
  "Walnut": "#5c3a1e",
  "Mid-Century Walnut": "#6b4830",
  "Honey Oak": "#c8923e",
  "Light Natural Oak": "#c9ad7c",
  "Honey": "#c08b3e",
  "Gold": "#c9a668",
  "Amber": "#b8860b",
  "Gray": "#9e9e9e",
  "Grey": "#9e9e9e",
  "Light Gray": "#c8c8c8",
  "Dark Gray": "#4a4a4a",
  "Charcoal": "#36454f",
  "Black": "#1c1917",
  "Black Onyx": "#0c0a08",
  "Silver": "#b0b0b0",
  "Greige": "#b5a999",
  "Blue": "#4a6fa5",
  "Navy": "#1b2a4a",
  "Green": "#5c7a5c",
  "Sage": "#6b9080",
  "Teal": "#367588",
  "Celadon": "#ace1af",
  "Smokey Celadon": "#8baa8b",
  "Red": "#8b3a3a",
  "Terracotta": "#c67b5c",
  "Rust": "#a0522d",
  "Orange": "#cc7722",
  "Yellow": "#d4a843",
  "Pink": "#c4868b",
  "Blush": "#d4a5a5",
  "Pecan": "#8b6914",
  "Multi": "#a8a29e",
  "Natural": "#c2a878",
  "Oak": "#b08550",
  "Ash": "#bfbcb6",
  "Slate": "#6d7b7b",
  "Pewter": "#8a8d8f",
  "Copper": "#b87333",
  "Bronze": "#8a6642",
  "Pearl": "#eae6df",
  "Caramel": "#a56630"
};
function getColorHex(colorName) {
  if (!colorName) return "#a8a29e";
  const name = colorName.trim();
  if (COLOR_HEX_MAP[name]) return COLOR_HEX_MAP[name];
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(COLOR_HEX_MAP)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
  }
  return "#a8a29e";
}
function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 200;
}
const LOOK_GRADIENT_MAP = {
  "Marble": "linear-gradient(135deg, #f0ece4 0%, #e8e0d4 25%, #f5f0ea 50%, #ddd5c8 75%, #ebe6de 100%)",
  "Wood": "linear-gradient(160deg, #a67c52 0%, #8b6238 30%, #c09a6b 55%, #7a5530 80%, #b8925a 100%)",
  "Concrete": "linear-gradient(135deg, #b0aba3 0%, #9e9890 35%, #c2bdb5 60%, #a8a299 100%)",
  "Stone": "linear-gradient(145deg, #c4b8a8 0%, #b0a492 30%, #d4c8b8 60%, #a89882 100%)",
  "Slate": "linear-gradient(140deg, #6d7b7b 0%, #5a6868 40%, #7d8b8b 70%, #4a5858 100%)",
  "Travertine": "linear-gradient(130deg, #e8d8c4 0%, #d4c4ae 35%, #f0e0cc 65%, #c8b8a0 100%)",
  "Limestone": "linear-gradient(135deg, #e0d8cc 0%, #d0c8ba 40%, #ece4d8 70%, #c8c0b2 100%)",
  "Terrazzo": "linear-gradient(135deg, #e8e0d4 0%, #d0c8bc 30%, #f0e8dc 50%, #c4bcb0 70%, #dcd4c8 100%)",
  "Cement": "linear-gradient(145deg, #a8a098 0%, #989088 40%, #b8b0a8 70%, #908880 100%)",
  "Onyx": "linear-gradient(135deg, #2c2826 0%, #1c1917 30%, #3c3834 55%, #0c0a08 80%, #2c2826 100%)",
  "Encaustic": "linear-gradient(135deg, #5c7a5c 0%, #4a6848 25%, #7c9a7c 50%, #3a5838 75%, #6b8a6b 100%)",
  "Geometric": "linear-gradient(135deg, #4a6fa5 0%, #3a5f95 30%, #5a7fb5 60%, #2a4f85 100%)",
  "Metallic": "linear-gradient(145deg, #b0b0b0 0%, #8a8a8a 25%, #d0d0d0 50%, #a0a0a0 75%, #c0c0c0 100%)",
  "Fabric": "linear-gradient(135deg, #c2b8aa 0%, #b0a698 35%, #d2c8ba 65%, #a49888 100%)",
  "Brick": "linear-gradient(140deg, #8b4513 0%, #a0522d 35%, #7a3b10 65%, #b8652a 100%)"
};
function getLookGradient(lookName) {
  if (!lookName) return "linear-gradient(135deg, #c2b8aa, #a49888)";
  if (LOOK_GRADIENT_MAP[lookName]) return LOOK_GRADIENT_MAP[lookName];
  const lower = lookName.toLowerCase();
  for (const [key, val] of Object.entries(LOOK_GRADIENT_MAP)) {
    if (lower.includes(key.toLowerCase())) return val;
  }
  return "linear-gradient(135deg, #c2b8aa, #a49888)";
}
const COLOR_FAMILIES = {
  "White": { hex: "#f5f5f0", keywords: ["white", "ivory", "cream", "snow", "pearl", "alabaster", "frost", "arctic", "bright white"] },
  "Gray": { hex: "#9e9e9e", keywords: ["gray", "grey", "charcoal", "silver", "slate", "ash", "smoke", "graphite", "pewter", "cement", "concrete"] },
  "Beige": { hex: "#d4c5a9", keywords: ["beige", "tan", "sand", "taupe", "khaki", "linen", "wheat", "bone", "champagne", "natural", "almond"] },
  "Brown": { hex: "#8b6f47", keywords: ["brown", "chocolate", "coffee", "mocha", "walnut", "chestnut", "mahogany", "espresso", "umber", "oak", "hickory", "pecan", "caramel"] },
  "Black": { hex: "#2c2c2c", keywords: ["black", "onyx", "ebony", "jet", "midnight", "noir", "obsidian"] },
  "Blue": { hex: "#6b8cae", keywords: ["blue", "navy", "cobalt", "teal", "aqua", "sapphire", "ocean", "azure", "cerulean", "indigo", "denim"] },
  "Green": { hex: "#7a9972", keywords: ["green", "sage", "olive", "forest", "emerald", "moss", "mint", "jade", "celadon"] },
  "Red": { hex: "#b54c4c", keywords: ["red", "burgundy", "wine", "cherry", "crimson", "maroon", "rust", "brick", "terracotta"] },
  "Gold": { hex: "#c9a668", keywords: ["gold", "golden", "honey", "amber", "copper", "bronze", "brass"] },
  "Blonde": { hex: "#dcc9a3", keywords: ["blonde", "blond", "flaxen", "straw", "light oak", "light natural"] },
  "Multi": { hex: "conic-gradient(#f5f5f0,#9e9e9e,#d4c5a9,#8b6f47,#6b8cae)", keywords: ["multi", "mixed", "multicolor", "variegated", "blend"] }
};
function mapColorToFamily(rawColor) {
  if (!rawColor) return null;
  const lower = rawColor.toLowerCase().trim();
  if (lower === "xxx" || lower === "n/a" || lower === "na" || !lower) return null;
  for (const [family, { keywords }] of Object.entries(COLOR_FAMILIES)) {
    if (keywords.some((kw) => lower.includes(kw))) return family;
  }
  return null;
}
function parseSizeDimensions(sizeStr) {
  if (!sizeStr) return { width: 16, height: 16 };
  const s = sizeStr.trim().replace(/"/g, "").replace(/\u201d/g, "");
  const xyMatch = s.match(/^(\d+(?:[.\-\/]\d+)?)\s*[xX×]\s*(\d+(?:[.\-\/]\d+)?)/);
  if (xyMatch) {
    const parse = (v) => {
      if (v.includes("/")) {
        const p = v.split("/");
        return parseFloat(p[0]) / parseFloat(p[1]);
      }
      return parseFloat(v);
    };
    const w = parse(xyMatch[1]);
    const h = parse(xyMatch[2]);
    const max = Math.max(w, h);
    return { width: Math.max(8, Math.round(w / max * 22)), height: Math.max(8, Math.round(h / max * 22)) };
  }
  const singleMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:in\.?)?$/);
  if (singleMatch) {
    const d = parseFloat(singleMatch[1]);
    if (d <= 12) return { width: Math.max(10, Math.round(d / 12 * 20)), height: 22 };
    return { width: 10, height: 22 };
  }
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
  if (!name) return "";
  if (/[A-Z]/.test(name) && name.includes(" ")) return name;
  const parts = name.split(/\s*\/\s*/);
  return parts.map((part) => {
    let formatted = part.replace(/-/g, " ");
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
function fullProductName(sku) {
  const attrs = (sku.attributes || []).reduce((m, a) => { m[a.slug] = a.value; return m; }, {});
  const col = sku.collection || "";
  const color = attrs.color || "";
  if (col && color) {
    // If product_name extends the collection (e.g. "After All I" vs collection "After All",
    // or "Easy Spirit II 12" vs "Easy Spirit"), use product_name to preserve distinguishing
    // suffixes like Roman numerals or roll-width variants.
    const rawName = sku.product_name || "";
    let baseName = col;
    if (rawName && rawName.length > col.length && rawName.toLowerCase().startsWith(col.toLowerCase() + " ")) {
      baseName = formatCarpetValue(rawName);
    } else if (rawName && !rawName.toLowerCase().startsWith(col.toLowerCase())) {
      // Product name is unrelated to collection (e.g. "Angora Floralis Polished" in
      // "Natural Stone Collections") — use product name, not collection
      baseName = formatCarpetValue(rawName);
    }
    // Roll carpet has roll dimensions as "size" (e.g., 12x150FT) — omit from title.
    // Carpet tile keeps its size (e.g., 24x24) since it's a real product dimension.
    const isRollCarpet = (sku.category_slug || "").toLowerCase() === "carpet";
    const size = isRollCarpet ? "" : (attrs.size || "");
    const finish = attrs.finish || "";
    return [baseName, color, finish, size].filter(Boolean).join(" ");
  }
  const rawName = sku.product_name || "";
  let name = formatCarpetValue(rawName);
  name = name.replace(/^\d+\s*[xX×]\s*\d+\w?\s+/, "");
  let showCollection = "";
  if (col && name) {
    const colLower = col.toLowerCase();
    const nameLower = name.toLowerCase();
    if (colLower === nameLower) {
      showCollection = "";
    } else if (nameLower.startsWith(colLower + " ") || nameLower.startsWith(colLower + "-")) {
      showCollection = "";
    } else if (nameLower.includes(" " + colLower + " ") || nameLower.endsWith(" " + colLower)) {
      showCollection = "";
    } else {
      showCollection = col;
    }
  }
  let variant = null;
  if (sku.variant_name && sku.variant_name.toLowerCase() !== rawName.toLowerCase()) {
    const vLower = sku.variant_name.toLowerCase().trim();
    const pLower = rawName.toLowerCase();
    const nLower = name.toLowerCase();
    if (vLower.startsWith(pLower + " ")) {
      const suffix = sku.variant_name.substring(rawName.length + 1).trim();
      variant = suffix ? formatVariantName(suffix) : null;
    } else if (pLower.startsWith(vLower + " ") || pLower === vLower) {
      variant = null;
    } else if (vLower.length > 2 && (nLower.includes(" " + vLower + " ") || nLower.endsWith(" " + vLower) || nLower.startsWith(vLower + " "))) {
      variant = null;
    } else {
      variant = formatVariantName(sku.variant_name);
    }
  }
  return [showCollection, name, variant].filter(Boolean).join(" ");
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
function StockBadge({ status, vendorHasInventory }) {
  if (vendorHasInventory === false && (status === "unknown" || status === "out_of_stock")) {
    return React.createElement("span", {
      className: "stock-badge stock-badge--unknown",
      style: { fontSize: "0.75rem" }
    }, "Call (714) 999-0009 for stock check");
  }
  const map = {
    in_stock: { label: "In Stock", cls: "in-stock" },
    low_stock: { label: "Low Stock", cls: "low-stock" },
    out_of_stock: { label: "Out of Stock", cls: "out-of-stock" }
  };
  const info = map[status] || { label: "Check Availability", cls: "unknown" };
  return React.createElement("span", { className: `stock-badge stock-badge--${info.cls}` }, info.label);
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
let stripeReady = null;
const stripePromise = new Promise((resolve) => {
  stripeReady = resolve;
});
(async () => {
  for (let i = 0; i < 50; i++) {
    if (typeof Stripe !== "undefined") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (typeof Stripe === "undefined") {
    console.warn("Stripe.js failed to load");
    stripeReady(null);
    return;
  }
  try {
    const r = await fetch((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:3001" : "") + "/api/config/stripe-key");
    const data = await r.json();
    if (data.key) stripeInstance = Stripe(data.key);
  } catch (e) {
    console.warn("Failed to load Stripe key:", e);
  }
  stripeReady(stripeInstance);
})();
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
function StorefrontApp() {
  const [view, setView] = useState("home");
  const [selectedSkuId, setSelectedSkuId] = useState(null);
  const [selectedCategorySlug, setSelectedCategorySlug] = useState(null);
  const [selectedProductSlug, setSelectedProductSlug] = useState(null);
  const [skus, setSkus] = useState([]);
  const [totalSkus, setTotalSkus] = useState(0);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDidYouMean, setSearchDidYouMean] = useState(null);
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
  const [appliedPromoCode, setAppliedPromoCode] = useState(null);
  const [quickViewSku, setQuickViewSku] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [visitRecapToken, setVisitRecapToken] = useState(null);
  const [klarnaReturn, setKlarnaReturn] = useState(null);
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
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const showToast = useCallback((message, type = "info", duration = 3500) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => t.id === id ? { ...t, leaving: true } : t));
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 350);
    }, duration);
  }, []);
  const [wishlist, setWishlist] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("wishlist") || "[]");
    } catch {
      return [];
    }
  });
  const [recentlyViewed, setRecentlyViewed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("recently_viewed") || "[]");
    } catch {
      return [];
    }
  });
  const addRecentlyViewed = (skuData) => {
    setRecentlyViewed((prev) => {
      const filtered = prev.filter((s) => s.sku_id !== skuData.sku_id);
      const updated = [{ sku_id: skuData.sku_id, product_name: skuData.product_name, variant_name: skuData.variant_name, primary_image: skuData.primary_image, retail_price: skuData.retail_price, price_basis: skuData.price_basis, sell_by: skuData.sell_by, sqft_per_box: skuData.sqft_per_box }, ...filtered].slice(0, 12);
      localStorage.setItem("recently_viewed", JSON.stringify(updated));
      return updated;
    });
  };
  const sessionId = useRef(getSessionId());
  const scrollY = useRef(0);
  const pendingScroll = useRef(null);
  const tradeHeaders = () => {
    const t = localStorage.getItem("trade_token");
    return t ? { "X-Trade-Token": t } : {};
  };
  const fetchSkusRef = useRef(null);
  const fetchFacetsRef = useRef(null);
  const fetchSkus = useCallback((opts = {}) => {
    const PAGE_SIZE = 72;
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
    if (sort) params.set("sort", sort);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page - 1) * PAGE_SIZE));
    const af = activeFilters || {};
    Object.keys(af).forEach((slug) => {
      if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join("|"));
    });
    const vf = vendors || [];
    if (vf.length > 0) params.set("vendor", vf.join("|"));
    if (priceMin != null) params.set("price_min", String(priceMin));
    if (priceMax != null) params.set("price_max", String(priceMax));
    const tf = tags || [];
    if (tf.length > 0) params.set("tags", tf.join("|"));
    setLoadingSkus(true);
    fetch(API + "/api/storefront/skus?" + params.toString(), { headers: tradeHeaders() }).then((r) => r.json()).then((data) => {
      setSkus(data.skus || []);
      setTotalSkus(data.total || 0);
      setSearchDidYouMean(data.didYouMean || null);
      setLoadingSkus(false);
      if (pendingScroll.current !== null) {
        const pos = pendingScroll.current;
        pendingScroll.current = null;
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, pos)));
      }
    }).catch((err) => {
      console.error(err);
      setLoadingSkus(false);
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
    if (vf.length > 0) params.set("vendor", vf.join("|"));
    if (priceMin != null) params.set("price_min", String(priceMin));
    if (priceMax != null) params.set("price_max", String(priceMax));
    const tf = tags || [];
    if (tf.length > 0) params.set("tags", tf.join("|"));
    fetch(API + "/api/storefront/facets?" + params.toString()).then((r) => r.json()).then((data) => {
      setFacets(data.facets || []);
      setVendorFacets(data.vendors || []);
      setTagFacets(data.tags || []);
      if (data.priceRange) setPriceRange(data.priceRange);
    }).catch((err) => console.error(err));
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
    fetch(API + "/api/cart?session_id=" + encodeURIComponent(sessionId.current)).then((r) => r.json()).then((data) => setCart(data.cart || [])).catch((err) => console.error(err));
  };
  const addToCart = (item) => {
    fetch(API + "/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...item, session_id: sessionId.current })
    }).then((r) => r.json()).then((data) => {
      if (data.error) {
        showToast(data.error, "error");
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
      }
    }).catch((err) => console.error(err));
  };
  const removeFromCart = (itemId) => {
    fetch(API + "/api/cart/" + itemId + "?session_id=" + encodeURIComponent(sessionId.current), { method: "DELETE" }).then((r) => r.json()).then(() => setCart((prev) => prev.filter((i) => i.id !== itemId))).catch((err) => console.error(err));
  };
  const updateCartItem = (itemId, updates) => {
    fetch(API + "/api/cart/" + itemId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, session_id: sessionId.current })
    }).then((r) => r.json()).then((data) => {
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
  const handleCustomerLogin = (token, cust) => {
    localStorage.setItem("customer_token", token);
    setCustomerToken(token);
    setCustomer(cust);
    setShowAuthModal(false);
    syncWishlistOnLogin(token);
  };
  const handleCustomerLogout = () => {
    const t = localStorage.getItem("customer_token");
    if (t) fetch(API + "/api/customer/logout", { method: "POST", headers: { "X-Customer-Token": t } }).catch(() => {
    });
    localStorage.removeItem("customer_token");
    setCustomerToken(null);
    setCustomer(null);
  };
  const toggleWishlist = (productId) => {
    const isWished = wishlist.includes(productId);
    let updated;
    if (isWished) {
      updated = wishlist.filter((id) => id !== productId);
      showToast("Removed from wishlist", "info");
    } else {
      updated = [productId, ...wishlist];
      showToast("Added to wishlist", "success");
    }
    setWishlist(updated);
    localStorage.setItem("wishlist", JSON.stringify(updated));
    const custToken = localStorage.getItem("customer_token");
    if (custToken) {
      if (isWished) {
        fetch(API + "/api/wishlist/" + productId, { method: "DELETE", headers: { "X-Customer-Token": custToken } }).catch(() => {
        });
      } else {
        fetch(API + "/api/wishlist", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Customer-Token": custToken },
          body: JSON.stringify({ product_id: productId })
        }).catch(() => {
        });
      }
    }
  };
  const syncWishlistOnLogin = (token) => {
    const localWishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
    if (localWishlist.length > 0) {
      fetch(API + "/api/wishlist/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Customer-Token": token },
        body: JSON.stringify({ product_ids: localWishlist })
      }).then((r) => r.json()).then((data) => {
        if (data.product_ids) {
          setWishlist(data.product_ids);
          localStorage.setItem("wishlist", JSON.stringify(data.product_ids));
        }
      }).catch(() => {
      });
    } else {
      fetch(API + "/api/wishlist", { headers: { "X-Customer-Token": token } }).then((r) => r.json()).then((data) => {
        if (data.product_ids) {
          setWishlist(data.product_ids);
          localStorage.setItem("wishlist", JSON.stringify(data.product_ids));
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
    }).then((r) => r.json()).then(() => {
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
    const servicePages = {
      "/design-services": "Design Services",
      "/about": "About Us"
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
    const firstCat = categories.length > 0 ? categories[0].slug : null;
    setSelectedCategory(firstCat);
    fetchSkus({ cat: firstCat, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [], page: 1 });
    fetchFacets({ cat: firstCat, coll: null, search: "", activeFilters: {}, vendors: [], priceMin: null, priceMax: null, tags: [] });
    pushShopUrl(firstCat, null, "", {}, false, [], null, null, []);
    window.scrollTo(0, 0);
  };
  const goSkuDetail = (skuId, productName, categorySlug, productSlug) => {
    if (view === "browse" || view === "home") scrollY.current = window.scrollY;
    setSelectedSkuId(skuId);
    setSelectedCategorySlug(categorySlug || null);
    setSelectedProductSlug(productSlug || null);
    setView("detail");
    const url = (categorySlug && productSlug)
      ? "/shop/" + categorySlug + "/" + productSlug
      : "/shop/sku/" + skuId + "/" + generateSlug(productName || "product");
    history.pushState({ view: "detail", skuId, categorySlug, productSlug }, "", url);
    window.scrollTo(0, 0);
  };
  const goBackToBrowse = () => {
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
    window.scrollTo(0, 0);
  };
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
    setSearchQuery(query);
    setSearchDidYouMean(null);
    setSelectedCategory(null);
    setSelectedCollection(null);
    setFilters({});
    setVendorFilters([]);
    setTagFilters([]);
    setUserPriceRange({ min: null, max: null });
    setCurrentPage(1);
    setView("browse");
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
  useEffect(() => {
    fetchCart();
    fetch(API + "/api/categories").then((r) => r.json()).then((data) => setCategories(data.categories || [])).catch((err) => console.error(err));
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
    const savedCustToken = localStorage.getItem("customer_token");
    if (savedCustToken) {
      fetch(API + "/api/customer/me", { headers: { "X-Customer-Token": savedCustToken } }).then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      }).then((data) => {
        setCustomer(data.customer);
        setCustomerToken(savedCustToken);
      }).catch(() => {
        localStorage.removeItem("customer_token");
        setCustomerToken(null);
      });
    }
    fetch(API + "/api/storefront/featured").then((r) => r.json()).then((data) => {
      setFeaturedSkus(data.skus || []);
      setFeaturedLoading(false);
    }).catch(() => {
      setFeaturedLoading(false);
    });
    fetch(API + "/api/storefront/facets").then((r) => r.json()).then((data) => setGlobalFacets(data.facets || [])).catch(console.error);
    const path = window.location.pathname;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("reset_token")) {
      setView("reset-password");
    } else if (path === "/" || path === "") {
      setView("home");
    } else if (path.startsWith("/shop/sku/")) {
      // Old UUID URL — redirect to slug-based URL
      const parts = path.replace("/shop/sku/", "").split("/");
      const oldSkuId = parts[0];
      fetch(API + "/api/storefront/sku-redirect/" + oldSkuId).then(r => r.json()).then(data => {
        if (data.categorySlug && data.productSlug) {
          setSelectedCategorySlug(data.categorySlug);
          setSelectedProductSlug(data.productSlug);
          history.replaceState({ view: "detail", skuId: oldSkuId, categorySlug: data.categorySlug, productSlug: data.productSlug }, "", "/shop/" + data.categorySlug + "/" + data.productSlug);
        }
      }).catch(() => {});
      setSelectedSkuId(oldSkuId);
      setView("detail");
    } else if (path.match(/^\/shop\/[a-z0-9-]+\/[a-z0-9-]+$/)) {
      // New slug-based URL: /shop/{categorySlug}/{productSlug}
      const slugParts = path.replace("/shop/", "").split("/");
      setSelectedCategorySlug(slugParts[0]);
      setSelectedProductSlug(slugParts[1]);
      setView("detail");
    } else if (path === "/cart" || path === "/shop/cart") {
      setView("cart");
    } else if (path === "/checkout" || path === "/shop/checkout") {
      const piParam = sp.get("payment_intent");
      const piClientSecret = sp.get("payment_intent_client_secret");
      const redirectStatus = sp.get("redirect_status");
      if (piParam && redirectStatus) {
        setKlarnaReturn({ paymentIntentId: piParam, clientSecret: piClientSecret, redirectStatus });
        history.replaceState({ view: "checkout" }, "", "/checkout");
      }
      setView("checkout");
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
    } else if (path === "/installation") {
      setView("installation");
    } else if (path === "/inspiration") {
      setView("inspiration");
    } else if (path === "/sale") {
      setView("sale");
    } else if (["/design-services", "/about"].includes(path)) {
      const titles = { "/design-services": "Design Services", "/about": "About Us" };
      setComingSoonTitle(titles[path]);
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
      if (q) setSearchQuery(q);
      if (Object.keys(af).length) setFilters(af);
      if (vf.length) setVendorFilters(vf);
      if (tf.length) setTagFilters(tf);
      if (prMin != null || prMax != null) setUserPriceRange({ min: prMin, max: prMax });
      fetchSkus({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
      fetchFacets({ cat, coll, search: q || "", activeFilters: af, vendors: vf, priceMin: prMin, priceMax: prMax, tags: tf });
    } else {
      setView("home");
    }
    const handlePop = (e) => {
      const state = e.state;
      if (state && state.view) {
        setView(state.view);
        if (state.view === "detail") {
          if (state.skuId) setSelectedSkuId(state.skuId);
          if (state.categorySlug) setSelectedCategorySlug(state.categorySlug);
          if (state.productSlug) setSelectedProductSlug(state.productSlug);
        }
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
        const p = window.location.pathname;
        if (p === "/" || p === "") {
          setView("home");
        } else if (p.startsWith("/shop/sku/")) {
          const parts = p.replace("/shop/sku/", "").split("/");
          setSelectedSkuId(parts[0]);
          setView("detail");
        } else if (p.match(/^\/shop\/[a-z0-9-]+\/[a-z0-9-]+$/)) {
          const slugParts = p.replace("/shop/", "").split("/");
          setSelectedCategorySlug(slugParts[0]);
          setSelectedProductSlug(slugParts[1]);
          setView("detail");
        } else if (p === "/trade") {
          setView("trade");
        } else if (p === "/trade/dashboard") {
          setView("trade-dashboard");
        } else if (p === "/sale") {
          setView("sale");
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
    if (view === "browse" && categories.length > 0 && !selectedCategory && !selectedCollection && !searchQuery && Object.keys(filters).length === 0) {
      const firstParent = categories[0];
      if (firstParent && firstParent.slug) {
        setSelectedCategory(firstParent.slug);
        fetchSkus({ cat: firstParent.slug, coll: null, search: "", activeFilters: filters, page: 1 });
        fetchFacets({ cat: firstParent.slug, coll: null, search: "", activeFilters: filters });
        pushShopUrl(firstParent.slug, null, "", filters, true, [], null, null, []);
      }
    }
  }, [view, categories]);
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
      "reset-password": { title: "Reset Password | Roma Flooring Designs", description: "Reset your password.", url: SITE_URL + "/reset-password" }
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
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
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
      onAccountClick: customer ? goAccount : () => {
        setAuthModalMode("login");
        setShowAuthModal(true);
      },
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
      navigate,
      wishlist,
      toggleWishlist,
      setQuickViewSku,
      newsletterEmail,
      setNewsletterEmail,
      newsletterSubmitted,
      onNewsletterSubmit: handleNewsletterSubmit,
      onOpenQuiz: () => setShowFloorQuiz(true)
    }
  ), view === "browse" && /* @__PURE__ */ React.createElement(
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
      onClearFilters: handleClearFilters,
      sortBy,
      onSortChange: handleSortChange,
      onSkuClick: goSkuDetail,
      currentPage,
      onPageChange: handlePageChange,
      wishlist,
      toggleWishlist,
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
      didYouMean: searchDidYouMean
    }
  ), view === "detail" && (selectedSkuId || (selectedCategorySlug && selectedProductSlug)) && /* @__PURE__ */ React.createElement(
    SkuDetailView,
    {
      key: selectedSkuId || (selectedCategorySlug + "/" + selectedProductSlug),
      skuId: selectedSkuId,
      categorySlug: selectedCategorySlug,
      productSlug: selectedProductSlug,
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
      toggleWishlist,
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
      sessionId: sessionId.current,
      appliedPromoCode,
      setAppliedPromoCode,
      goHome
    }
  ), view === "checkout" && /* @__PURE__ */ React.createElement(
    CheckoutPage,
    {
      cart,
      sessionId: sessionId.current,
      goCart,
      handleOrderComplete,
      deliveryMethod,
      tradeCustomer,
      tradeToken,
      customer,
      customerToken,
      onCustomerLogin: handleCustomerLogin,
      appliedPromoCode,
      setAppliedPromoCode,
      klarnaReturn
    }
  ), view === "confirmation" && /* @__PURE__ */ React.createElement(ConfirmationPage, { orderData: completedOrder, goBrowse }), view === "account" && (customer ? /* @__PURE__ */ React.createElement(AccountPage, { customer, customerToken, setCustomer, goBrowse }) : /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "4rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, marginBottom: "1rem" } }, "Sign In Required"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Please sign in to view your account."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
    setAuthModalMode("login");
    setShowAuthModal(true);
  } }, "Sign In"))), view === "wishlist" && /* @__PURE__ */ React.createElement(WishlistPage, { wishlist, toggleWishlist, onSkuClick: goSkuDetail, goBrowse, recentlyViewed, goHome }), view === "collections" && /* @__PURE__ */ React.createElement(CollectionsPage, { onCollectionClick: handleCollectionClick, goHome }), view === "trade" && /* @__PURE__ */ React.createElement(TradePage, { goTradeDashboard, onApplyClick: () => {
    setTradeModalMode("register");
    setShowTradeModal(true);
  }, tradeCustomer }), view === "trade-dashboard" && (tradeCustomer ? /* @__PURE__ */ React.createElement(TradeDashboard, { tradeCustomer, tradeToken, addToCart, goBrowse, setTradeCustomer, handleTradeLogout, goBulkOrder, showToast }) : /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "4rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, marginBottom: "1rem" } }, "Trade Login Required"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Please sign in with your trade account to access the dashboard."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
    setTradeModalMode("login");
    setShowTradeModal(true);
  } }, "Trade Sign In"))), view === "bulk-order" && /* @__PURE__ */ React.createElement(BulkOrderPage, { tradeToken, addToCart, goTradeDashboard, showToast }), view === "visit-recap" && visitRecapToken && /* @__PURE__ */ React.createElement(VisitRecapPage, { token: visitRecapToken, onSkuClick: goSkuDetail }), view === "reset-password" && /* @__PURE__ */ React.createElement(ResetPasswordPage, { goHome, openLogin: () => {
    setAuthModalMode("login");
    setShowAuthModal(true);
  } }), view === "installation" && /* @__PURE__ */ React.createElement(InstallationPage, { onRequestQuote: () => {
    setInstallModalProduct(null);
    setShowInstallModal(true);
  } }), view === "inspiration" && /* @__PURE__ */ React.createElement(InspirationPage, { navigate, goBrowse }), view === "sale" && /* @__PURE__ */ React.createElement(SalePage, { onSkuClick: goSkuDetail, wishlist, toggleWishlist, setQuickViewSku, navigate }), view === "coming-soon" && /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "6rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, fontSize: "2.5rem", marginBottom: "1rem" } }, comingSoonTitle), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "1.125rem", lineHeight: 1.6, marginBottom: "2rem" } }, "This page is coming soon. We're working on something beautiful."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goHome }, "Back to Home")), /* @__PURE__ */ React.createElement(
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
  } }), /* @__PURE__ */ React.createElement(
    SiteFooter,
    {
      goHome,
      goBrowse,
      goCollections,
      goTrade,
      onInstallClick: goInstallation
    }
  ), /* @__PURE__ */ React.createElement("nav", { className: "mobile-bottom-nav" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "home" ? " active" : ""), onClick: goHome }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 22 9 12 15 12 15 22" })), "Home"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "browse" ? " active" : ""), onClick: () => setMobileSearchOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })), "Search"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item", onClick: () => setCartDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), cart.length > 0 && /* @__PURE__ */ React.createElement("span", { className: "mobile-bottom-nav-badge" }, cart.length), "Cart"), /* @__PURE__ */ React.createElement("button", { className: "mobile-bottom-nav-item" + (view === "account" ? " active" : ""), onClick: customer ? goAccount : () => {
    setAuthModalMode("login");
    setShowAuthModal(true);
  } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" })), "Account")), /* @__PURE__ */ React.createElement(BackToTop, null), /* @__PURE__ */ React.createElement(ToastContainer, { toasts }));
}
function Header({ goHome, goBrowse, cart, cartDrawerOpen, setCartDrawerOpen, cartFlash, onSearch, onSkuClick, tradeCustomer, onTradeClick, onTradeLogout, customer, onAccountClick, onCustomerLogout, wishlistCount, goWishlist, goCollections, categories, onCategorySelect, globalFacets, onAxisSelect, mobileNavOpen, setMobileNavOpen, mobileSearchOpen, setMobileSearchOpen, view, navigate, goSale }) {
  const [searchInput, setSearchInput] = useState("");
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
  useEffect(() => {
    fetch(API + "/api/storefront/search/popular").then((r) => r.json()).then((d) => setPopularSearches(d.terms || [])).catch(() => {
    });
  }, []);
  const handleMaterialEnter = (slug) => {
    clearTimeout(materialTimerRef.current);
    setMaterialHover(slug);
  };
  const handleMaterialLeave = () => {
    materialTimerRef.current = setTimeout(() => setMaterialHover(null), 120);
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
        const data = await res.json();
        if (!controller.signal.aborted) {
          setSuggestData({ categories: data.categories || [], collections: data.collections || [], products: data.products || [], total: data.total || 0, didYouMean: data.didYouMean, expandedFrom: data.expandedFrom, expandedTo: data.expandedTo });
          setShowSuggestions(true);
          setActiveIdx(-1);
          setSuggestLoading(false);
        }
      } catch (e) {
        if (e.name !== "AbortError") setSuggestData({ categories: [], collections: [], products: [], total: 0 });
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
      onSkuClick(item.data.sku_id, item.data.product_name || item.data.collection, item.data.category_slug, item.data.product_slug);
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
    if (!showSuggestions || totalItems === 0) return;
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
      if (preArrowInputRef.current !== null) {
        setSearchInput(preArrowInputRef.current);
        preArrowInputRef.current = null;
      }
    }
  };
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) setShowSuggestions(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
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
      setSearchInput("");
    }
  } }, /* @__PURE__ */ React.createElement("button", { type: "submit", className: "header-search-icon", tabIndex: -1, "aria-label": "Search" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Search products...", value: searchInput, autoComplete: "off", onChange: handleSearchInput, onKeyDown: handleSearchKeyDown, onFocus: () => {
    if (hasSuggestResults || !searchInput && (popularSearches.length > 0 || recentSearches.length > 0)) setShowSuggestions(true);
  } }), searchInput && /* @__PURE__ */ React.createElement("button", { type: "button", className: "header-search-clear", onClick: () => {
    setSearchInput("");
    setSuggestData({ categories: [], collections: [], products: [], total: 0 });
    setShowSuggestions(false);
  }, "aria-label": "Clear search" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" }))), showSuggestions && !searchInput && (recentSearches.length > 0 || popularSearches.length > 0) && /* @__PURE__ */ React.createElement("div", { className: "search-suggestions" }, recentSearches.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Recent Searches", /* @__PURE__ */ React.createElement("button", { className: "search-recent-clear", onClick: (e) => {
    e.stopPropagation();
    clearRecentSearches();
    setRecentSearches([]);
  } }, "Clear")), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-popular" }, recentSearches.map((term) => {
    const idx = suggestItemIdx++;
    return /* @__PURE__ */ React.createElement("div", { key: term, className: "search-suggest-popular-item" + (idx === activeIdx ? " active" : ""), onClick: () => {
      addRecentSearch(term);
      setRecentSearches(getRecentSearches());
      onSearch(term);
      setShowSuggestions(false);
      setSearchInput("");
    } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("polyline", { points: "12 6 12 12 16 14" })), term);
  }))), popularSearches.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Popular Searches"), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-popular" }, popularSearches.map((term) => {
    const idx = suggestItemIdx++;
    return /* @__PURE__ */ React.createElement("div", { key: term, className: "search-suggest-popular-item" + (idx === activeIdx ? " active" : ""), onClick: () => {
      addRecentSearch(term);
      setRecentSearches(getRecentSearches());
      onSearch(term);
      setShowSuggestions(false);
      setSearchInput("");
    } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "23 6 13.5 15.5 8.5 10.5 1 18" }), /* @__PURE__ */ React.createElement("polyline", { points: "17 6 23 6 23 12" })), term);
  })))), showSuggestions && suggestLoading && searchInput && !hasSuggestResults && /* @__PURE__ */ React.createElement("div", { className: "search-suggestions" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-loading" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-loading-dots" }, /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement("span", null), /* @__PURE__ */ React.createElement("span", null)), "Searching...")), showSuggestions && !hasSuggestResults && !suggestLoading && searchInput && searchInput.length >= 2 && suggestData.didYouMean && /* @__PURE__ */ React.createElement("div", { className: "search-suggestions" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-did-you-mean", onClick: () => {
    onSearch(suggestData.didYouMean);
    setShowSuggestions(false);
    setSearchInput("");
  } }, "Did you mean: ", /* @__PURE__ */ React.createElement("strong", null, suggestData.didYouMean), "?"))), showSuggestions && hasSuggestResults && /* @__PURE__ */ React.createElement("div", { className: "search-suggestions" }, suggestData.expandedFrom && /* @__PURE__ */ React.createElement("div", { className: "search-expanded-indicator" }, "Showing results for ", /* @__PURE__ */ React.createElement("strong", null, suggestData.expandedTo ? suggestData.expandedTo.split(" ").slice(0, 4).join(" ") : suggestData.expandedFrom)), suggestData.categories.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Categories"), suggestData.categories.map((cat) => {
    const idx = suggestItemIdx++;
    return /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "search-suggest-item" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "category", data: cat }) }, /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" }))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-category-text" }, highlightMatch(cat.name, searchInput)), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, cat.product_count, " products"));
  })), suggestData.collections.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Collections"), suggestData.collections.map((col) => {
    const idx = suggestItemIdx++;
    return /* @__PURE__ */ React.createElement("div", { key: col.name, className: "search-suggest-item" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "collection", data: col }) }, col.image ? /* @__PURE__ */ React.createElement("img", { className: "search-suggest-collection-img", src: thumbUrl(col.image, 80), alt: "", decoding: "async", loading: "lazy", width: 48, height: 48 }) : /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" }))), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-name" }, highlightMatch(col.name, searchInput))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, col.product_count, " products"));
  })), suggestData.products.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Products"), suggestData.products.map((sku) => {
    const idx = suggestItemIdx++;
    return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "search-suggestion" + (idx === activeIdx ? " active" : ""), onClick: () => selectSuggestion({ type: "product", data: sku }) }, /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-img" }, sku.primary_image ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(sku.primary_image, 80), alt: "", decoding: "async", loading: "lazy", width: 48, height: 48, onError: handleImgError }) : /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 24, height: 24, color: "var(--stone-300)" } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "8.5", cy: "8.5", r: "1.5" }), /* @__PURE__ */ React.createElement("path", { d: "m21 15-5-5L5 21" }))), /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-name" }, highlightMatch(fullProductName(sku), searchInput)), sku.vendor_name && /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-vendor" }, sku.vendor_name), sku.variant_name && /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-variant" }, formatCarpetValue(sku.variant_name)), tradeCustomer && sku.vendor_sku && /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-sku" }, "SKU: ", sku.vendor_sku)), /* @__PURE__ */ React.createElement("span", { className: "search-suggestion-price" }, "$", displayPrice(sku, sku.retail_price).toFixed(2), priceSuffix(sku)));
  })), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-footer", onClick: () => {
    const q = searchInput.trim();
    if (q) {
      addRecentSearch(q);
      setRecentSearches(getRecentSearches());
    }
    onSearch(q);
    setShowSuggestions(false);
    setSearchInput("");
  } }, "View all ", suggestData.total, " results")));
  return /* @__PURE__ */ React.createElement("header", { className: condensed ? "header-condensed" : "" }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar" }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar-inner" }, /* @__PURE__ */ React.createElement("div", { className: "utility-bar-left" }, /* @__PURE__ */ React.createElement("a", { href: "tel:+17149990009", className: "utility-bar-phone" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" })), "(714) 999-0009"), /* @__PURE__ */ React.createElement("span", { className: "utility-bar-dot" }, "\u2022"), /* @__PURE__ */ React.createElement("span", null, "Anaheim, CA Showroom")), /* @__PURE__ */ React.createElement("div", { className: "utility-bar-right" }, /* @__PURE__ */ React.createElement("button", { onClick: onTradeClick }, tradeCustomer ? `Trade: ${tradeCustomer.company_name}` : "Trade Program"), /* @__PURE__ */ React.createElement("span", { className: "utility-bar-dot" }, "\u2022"), /* @__PURE__ */ React.createElement("button", { onClick: onAccountClick }, customer ? `Hi, ${customer.first_name}` : "Sign In")))), /* @__PURE__ */ React.createElement("div", { className: "header-main" }, /* @__PURE__ */ React.createElement("div", { className: "header-main-left" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-menu-btn", "aria-label": "Open navigation menu", onClick: () => setMobileNavOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "18", x2: "21", y2: "18" }))), searchForm), /* @__PURE__ */ React.createElement("div", { className: "logo", onClick: goHome }, /* @__PURE__ */ React.createElement("img", { src: "/assets/logo/roma-transparent.png", alt: "Roma Flooring Designs", width: "120", height: "38", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "header-main-right" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-search-btn", "aria-label": "Search products", onClick: () => setMobileSearchOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn", onClick: onAccountClick, "aria-label": "Account", title: customer ? customer.first_name : "Account" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" }))), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn wishlist-header-wrap", "aria-label": "Wishlist", onClick: goWishlist }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), wishlistCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "wishlist-badge" }, wishlistCount)), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn" + (cartFlash ? " cart-flash" : ""), "aria-label": "Shopping cart", onClick: () => setCartDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), itemCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "cart-badge" }, itemCount)))), /* @__PURE__ */ React.createElement("div", { className: "nav-row" }, /* @__PURE__ */ React.createElement("div", { className: "nav-row-inner" }, /* @__PURE__ */ React.createElement("div", { className: "nav-row-group" }, /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: goCollections }, "Collections"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/shop?sort=newest") }, "New Arrivals"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: goSale }, "Sale"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/shop?room=kitchen") }, "Shop by Room")), /* @__PURE__ */ React.createElement("span", { className: "nav-row-separator" }), /* @__PURE__ */ React.createElement("div", { className: "nav-row-group" }, /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/inspiration") }, "Inspiration"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/design-services") }, "Design Services"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/installation") }, "Installation"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: onTradeClick }, "Trade"), /* @__PURE__ */ React.createElement("button", { className: "nav-row-link", onClick: () => navigate("/about") }, "About Us")))), /* @__PURE__ */ React.createElement("div", { className: "material-bar" }, /* @__PURE__ */ React.createElement("div", { className: "material-bar-inner" }, parentCats.map((cat) => {
    const children = categories.filter((c) => c.parent_id === cat.id);
    const hasChildren = children.length > 0;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        key: cat.slug,
        className: "material-bar-item",
        onMouseEnter: () => hasChildren && handleMaterialEnter(cat.slug),
        onMouseLeave: handleMaterialLeave
      },
      /* @__PURE__ */ React.createElement("button", { className: "material-bar-link", onClick: () => onCategorySelect(cat.slug) }, cat.name, hasChildren && /* @__PURE__ */ React.createElement("span", { className: "material-bar-chevron" }, "\u25BE")),
      hasChildren && /* @__PURE__ */ React.createElement(
        "div",
        {
          className: "material-dropdown" + (materialHover === cat.slug ? " visible" : ""),
          onMouseEnter: () => handleMaterialEnter(cat.slug),
          onMouseLeave: handleMaterialLeave
        },
        children.map((child) => /* @__PURE__ */ React.createElement("a", { key: child.slug, onClick: () => onCategorySelect(child.slug) }, child.name)),
        /* @__PURE__ */ React.createElement("a", { className: "material-dropdown-viewall", onClick: () => onCategorySelect(cat.slug) }, "View All ", cat.name, " \u2192")
      )
    );
  }))), /* @__PURE__ */ React.createElement("div", { className: "mega-menu-scrim" + (materialHover ? " visible" : "") }));
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
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Cart (", itemCount, ")"), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: onClose }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), itemCount === 0 ? /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-empty" }, "Your cart is empty") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-items" }, cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "cart-drawer-item" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-img" }, /* @__PURE__ */ React.createElement("img", { src: item.primary_image ? thumbUrl(item.primary_image, 100) : PLACEHOLDER_SVG, alt: "", decoding: "async", loading: "lazy", width: 40, height: 40, onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-info" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-name" }, fullProductName(item) || "Product", item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "sample-tag" }, "Sample"), !item.is_sample && item.stock_status === "out_of_stock" && item.vendor_has_inventory !== false && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.625rem", fontWeight: 600, background: "#fef3c7", color: "#92400e" } }, "Backorder \u2014 2-4 weeks")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-meta" }, item.is_sample ? "FREE SAMPLE" : item.sell_by === "unit" ? `Qty: ${item.num_boxes}` : `${item.price_tier ? "" : item.num_boxes + " box" + (parseInt(item.num_boxes) !== 1 ? "es" : "") + " \xB7 "}${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft`, item.price_tier && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: item.price_tier === "roll" ? "var(--sage, #6b9080)" : "var(--stone-200)", color: item.price_tier === "roll" ? "white" : "var(--stone-600)" } }, item.price_tier === "roll" ? "Roll" : "Cut")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "cart-drawer-item-price" }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-item-remove", onClick: () => removeFromCart(item.id) }, "Remove")))))), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-footer" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, onClick: () => {
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
    const colorSiblings = (data.same_product_siblings || []).filter((s) => s.variant_type !== "accessory" && s.primary_image);
    setSiblings(colorSiblings);
  };
  const getTradeHeaders = () => {
    const t = localStorage.getItem("trade_token");
    return t ? { "X-Trade-Token": t } : {};
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/storefront/skus/" + initialSku.sku_id, { headers: getTradeHeaders() }).then((r) => r.json()).then((data) => {
      if (!cancelled) applyDetail(data);
    }).catch((err) => console.error("QuickView fetch error:", err)).finally(() => {
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
      else if (e.key === "ArrowRight") setImgIndex((i) => Math.min(i + 1, media.length - 1));
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [media.length]);
  const handleAdd = () => {
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
    setActiveSku((prev) => ({ ...prev, sku_id: sib.sku_id, variant_name: sib.variant_name, retail_price: sib.retail_price, primary_image: sib.primary_image, sell_by: sib.sell_by, price_basis: sib.price_basis, sqft_per_box: sib.sqft_per_box }));
    fetch("/api/storefront/skus/" + sib.sku_id, { headers: getTradeHeaders() }).then((r) => r.json()).then((data) => applyDetail(data));
  };
  const currentImg = media[imgIndex] || {};
  return /* @__PURE__ */ React.createElement("div", { className: "quick-view-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "quick-view", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "quick-view-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "quick-view-gallery" }, /* @__PURE__ */ React.createElement("div", { className: "quick-view-main-image" }, media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow left", disabled: imgIndex === 0, onClick: () => setImgIndex((i) => i - 1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" }))), /* @__PURE__ */ React.createElement("img", { src: currentImg.url ? thumbUrl(currentImg.url, 600) : PLACEHOLDER_SVG, alt: activeSku.product_name, decoding: "async", width: 400, height: 400, onError: handleImgError }), media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow right", disabled: imgIndex >= media.length - 1, onClick: () => setImgIndex((i) => i + 1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "9 18 15 12 9 6" })))), media.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-gallery-dots" }, media.map((_, i) => /* @__PURE__ */ React.createElement("span", { key: i, className: i === imgIndex ? "active" : "", onClick: () => setImgIndex(i) }))), siblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-variants" }, /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "quick-view-variant-swatch active",
      title: formatVariantName(activeSku.variant_name)
    },
    (baseMediaRef.current[0] || {}).url && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(baseMediaRef.current[0].url, 80), alt: activeSku.variant_name, decoding: "async", width: 64, height: 64 })
  ), siblings.map((sib) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: sib.sku_id,
      className: "quick-view-variant-swatch",
      title: formatVariantName(sib.variant_name),
      onMouseEnter: () => handleVariantHover(sib),
      onMouseLeave: handleVariantLeave,
      onClick: () => handleVariantClick(sib)
    },
    sib.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(sib.primary_image, 80), alt: sib.variant_name, decoding: "async", width: 64, height: 64 })
  )))), /* @__PURE__ */ React.createElement("div", { className: "quick-view-info" }, /* @__PURE__ */ React.createElement("h2", null, fullProductName(activeSku)), /* @__PURE__ */ React.createElement("div", { className: "price" }, activeSku.trade_price && activeSku.retail_price && /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "1rem", marginRight: "0.5rem" } }, "$", displayPrice(activeSku, activeSku.retail_price).toFixed(2)), !activeSku.trade_price && activeSku.sale_price && activeSku.retail_price && /* @__PURE__ */ React.createElement("span", { className: "sale-original-price" }, "$", displayPrice(activeSku, activeSku.retail_price).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: !activeSku.trade_price && activeSku.sale_price ? "sale-price-text" : "" }, "$", displayPrice(activeSku, activeSku.trade_price || activeSku.sale_price || activeSku.retail_price || 0).toFixed(2)), /* @__PURE__ */ React.createElement("span", null, priceSuffix(activeSku)), !activeSku.trade_price && activeSku.sale_price && activeSku.retail_price && /* @__PURE__ */ React.createElement("span", { className: "sale-discount-tag" }, Math.round((1 - parseFloat(activeSku.sale_price) / parseFloat(activeSku.retail_price)) * 100), "% off")), activeSku.description_short && /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-600)", lineHeight: 1.6, marginBottom: "1rem" } }, activeSku.description_short), /* @__PURE__ */ React.createElement("div", { className: "quick-view-actions" }, isUnit ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => Math.max(1, q - 1)) }, "-"), /* @__PURE__ */ React.createElement("input", { type: "number", value: qty, onChange: (e) => setQty(Math.max(1, parseInt(e.target.value) || 1)) }), /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => q + 1) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: handleAdd }, "Add to Cart")) : /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, "Use the coverage calculator on the detail page to add this item to your cart."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: () => onViewDetail(activeSku.sku_id, activeSku.product_name) }, "View Full Details")))));
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
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("nav", { className: "mobile-nav" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-head" }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-heading)", fontSize: "1.25rem", fontWeight: 600 } }, "Menu"), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", fontSize: "1.5rem", color: "var(--stone-500)", cursor: "pointer" } }, "\xD7")), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-links" }, /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goHome();
    onClose();
  } }, "Home"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goBrowse();
    onClose();
  } }, "Shop All"), parentCats.map((cat) => {
    const children = categories.filter((c) => c.parent_id === cat.id);
    if (children.length === 0) {
      return /* @__PURE__ */ React.createElement("a", { key: cat.id, onClick: () => {
        onCategorySelect(cat.slug);
        onClose();
      } }, cat.name);
    }
    return /* @__PURE__ */ React.createElement("div", { key: cat.id, className: "mobile-nav-cat-item" }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-cat-header", onClick: () => setExpandedCat(expandedCat === cat.id ? null : cat.id) }, /* @__PURE__ */ React.createElement("span", null, cat.name), /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16, transform: expandedCat === cat.id ? "rotate(180deg)" : "none", transition: "transform 0.2s" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))), expandedCat === cat.id && /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-cat-children" }, /* @__PURE__ */ React.createElement("a", { onClick: () => {
      onCategorySelect(cat.slug);
      onClose();
    } }, "All ", cat.name), children.map((child) => /* @__PURE__ */ React.createElement("a", { key: child.id, onClick: () => {
      onCategorySelect(child.slug);
      onClose();
    } }, child.name))));
  }), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goCollections();
    onClose();
  } }, "Collections")), !tradeCustomer && /* @__PURE__ */ React.createElement("a", { className: "mobile-nav-trade-cta", onClick: () => {
    onTradeClick();
    onClose();
  } }, "Trade Program"), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-footer" }, customer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Signed in as ", customer.first_name || customer.email), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goAccount();
    onClose();
  } }, "My Account"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    onCustomerLogout();
    onClose();
  } }, "Sign Out")) : tradeCustomer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Trade: ", tradeCustomer.company_name), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goTrade();
    onClose();
  } }, "Trade Dashboard"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    onTradeLogout();
    onClose();
  } }, "Sign Out")) : /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("a", { onClick: () => {
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
  const abortRef = useRef(null);
  useEffect(() => {
    if (open) {
      if (inputRef.current) setTimeout(() => inputRef.current.focus(), 100);
      setMobileRecent(getRecentSearches());
      fetch(API + "/api/storefront/search/popular").then((r) => r.json()).then((d) => setMobilePopular(d.terms || [])).catch(() => {
      });
    }
    if (!open) {
      setQuery("");
      setSuggestData({ categories: [], collections: [], products: [], total: 0 });
      if (abortRef.current) abortRef.current.abort();
    }
  }, [open]);
  useEffect(() => {
    if (!query || query.length < 2) {
      setSuggestData({ categories: [], collections: [], products: [], total: 0 });
      setLoading(false);
      return;
    }
    clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(API + "/api/storefront/search/suggest?q=" + encodeURIComponent(query), { signal: controller.signal });
        const data = await res.json();
        if (!controller.signal.aborted) {
          setSuggestData({ categories: data.categories || [], collections: data.collections || [], products: data.products || [], total: data.total || 0, didYouMean: data.didYouMean, expandedFrom: data.expandedFrom, expandedTo: data.expandedTo });
          setLoading(false);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          setSuggestData({ categories: [], collections: [], products: [], total: 0 });
          setLoading(false);
        }
      }
    }, 250);
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
  } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "23 6 13.5 15.5 8.5 10.5 1 18" }), /* @__PURE__ */ React.createElement("polyline", { points: "17 6 23 6 23 12" })), term))))), !hasResults && !loading && query && query.length >= 2 && suggestData.didYouMean && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-did-you-mean", onClick: () => {
    setQuery(suggestData.didYouMean);
  } }, "Did you mean: ", /* @__PURE__ */ React.createElement("strong", null, suggestData.didYouMean), "?"))), hasResults && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, suggestData.expandedFrom && /* @__PURE__ */ React.createElement("div", { className: "search-expanded-indicator" }, "Showing results for ", /* @__PURE__ */ React.createElement("strong", null, suggestData.expandedTo ? suggestData.expandedTo.split(" ").slice(0, 4).join(" ") : suggestData.expandedFrom)), suggestData.categories.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Categories"), suggestData.categories.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "search-suggest-item", onClick: () => {
    addRecentSearch(cat.name);
    onCategorySelect(cat.slug);
    onClose();
  } }, /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" }))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-category-text" }, highlightMatch(cat.name, query)), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, cat.product_count)))), suggestData.collections.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Collections"), suggestData.collections.map((col) => /* @__PURE__ */ React.createElement("div", { key: col.name, className: "search-suggest-item", onClick: () => {
    addRecentSearch(col.name);
    onSearch(col.name);
    onClose();
  } }, col.image ? /* @__PURE__ */ React.createElement("img", { className: "search-suggest-collection-img", src: thumbUrl(col.image, 80), alt: "", decoding: "async", loading: "lazy", width: 48, height: 48 }) : /* @__PURE__ */ React.createElement("span", { className: "search-suggest-item-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" }))), /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-collection-name" }, highlightMatch(col.name, query))), /* @__PURE__ */ React.createElement("span", { className: "search-suggest-count" }, col.product_count)))), suggestData.products.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-section" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggest-label" }, "Products"), suggestData.products.map((sku) => /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "mobile-search-result", onClick: () => {
    addRecentSearch(sku.product_name || sku.collection);
    onSkuClick(sku.sku_id, sku.product_name, sku.category_slug, sku.product_slug);
    onClose();
  } }, /* @__PURE__ */ React.createElement("div", { className: "mobile-search-result-img" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(sku.primary_image, 80), alt: "", decoding: "async", loading: "lazy", width: 48, height: 48 })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, fontSize: "0.875rem" } }, highlightMatch(fullProductName(sku), query)), sku.vendor_name && /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-vendor" }, sku.vendor_name), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, "$", displayPrice(sku, sku.retail_price).toFixed(2), priceSuffix(sku)))))), suggestData.total > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggest-footer", onClick: () => {
    const q = query.trim();
    if (q) {
      addRecentSearch(q);
    }
    onSearch(q);
    onClose();
  } }, "View all ", suggestData.total, " results")), loading && /* @__PURE__ */ React.createElement("div", { style: { padding: "0.5rem 1rem" } }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-search-result" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-lines" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short", style: { marginTop: 0 } }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })))))) : null;
}
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
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const maxIndex = Math.max(0, categories.length - visible);
  const clamped = Math.min(index, maxIndex);
  useEffect(() => {
    if (!trackRef.current) return;
    const tile = trackRef.current.children[0];
    if (!tile) return;
    const gap = 24;
    const tileW = tile.offsetWidth + gap;
    trackRef.current.scrollTo({ left: clamped * tileW, behavior: "smooth" });
  }, [clamped, visible]);
  const go = (dir) => setIndex((i) => Math.max(0, Math.min(i + dir, maxIndex)));
  return /* @__PURE__ */ React.createElement("div", { className: "category-carousel" }, /* @__PURE__ */ React.createElement("button", { className: "carousel-arrow carousel-arrow-left", disabled: clamped === 0, onClick: () => go(-1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" }))), /* @__PURE__ */ React.createElement("div", { className: "category-carousel-track", ref: trackRef }, categories.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "category-tile", onClick: () => onCategorySelect(cat.slug) }, cat.image_url && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(cat.image_url, 500), alt: cat.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "category-tile-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "category-tile-name" }, cat.name), /* @__PURE__ */ React.createElement("span", { className: "category-tile-count" }, cat.product_count, " products"))))), /* @__PURE__ */ React.createElement("button", { className: "carousel-arrow carousel-arrow-right", disabled: clamped >= maxIndex, onClick: () => go(1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "9 18 15 12 9 6" }))), maxIndex > 0 && /* @__PURE__ */ React.createElement("div", { className: "carousel-dots" }, Array.from({ length: maxIndex + 1 }, (_, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "carousel-dot" + (i === clamped ? " active" : ""), onClick: () => setIndex(i) }))));
}
function HomePage({ featuredSkus, featuredLoading, categories, onSkuClick, onCategorySelect, goBrowse, goTrade, navigate, wishlist, toggleWishlist, setQuickViewSku, newsletterEmail, setNewsletterEmail, newsletterSubmitted, onNewsletterSubmit, onOpenQuiz }) {
  const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
  const topCats = parentCats.slice(0, 6);
  const heroRef = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (heroRef.current) heroRef.current.classList.add("loaded");
    }, 100);
    return () => clearTimeout(timer);
  }, []);
  const looks = [
    { name: "Modern Minimalist", slug: "modern-minimalist", image: "/uploads/looks/modern-minimalist.jpg" },
    { name: "Warm Mediterranean", slug: "warm-mediterranean", image: "/uploads/looks/warm-mediterranean.jpg" },
    { name: "Coastal Retreat", slug: "coastal-retreat", image: "/uploads/looks/coastal-retreat.jpg" },
    { name: "Classic Elegance", slug: "classic-elegance", image: "/uploads/looks/classic-elegance.jpg" }
  ];
  const inspoImages = [
    { src: "/uploads/inspo/kitchen.jpg", label: "Kitchen" },
    { src: "/uploads/inspo/living-room.jpg", label: "Living Room", tall: true },
    { src: "/uploads/inspo/bathroom.jpg", label: "Bathroom" },
    { src: "/uploads/inspo/bedroom.jpg", label: "Bedroom" },
    { src: "/uploads/inspo/outdoor.jpg", label: "Outdoor" }
  ];
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("section", { className: "hero", ref: heroRef }, /* @__PURE__ */ React.createElement("div", { className: "hero-bg", style: { backgroundImage: "url(/uploads/hero-bg.jpg?v=2)" } }), /* @__PURE__ */ React.createElement("div", { className: "hero-content" }, /* @__PURE__ */ React.createElement("h1", null, "Redefine Your Space"), /* @__PURE__ */ React.createElement("button", { className: "hero-cta", onClick: goBrowse }, "Explore Our Floors"))), /* @__PURE__ */ React.createElement(RevealSection, null, /* @__PURE__ */ React.createElement("div", { className: "trust-strip" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-inner" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-item" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "7", width: "20", height: "14", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M16 7V5a4 4 0 00-8 0v2" }))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-text" }, "Free Samples", /* @__PURE__ */ React.createElement("span", null, "Try before you buy"))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-item" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "5" }))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-text" }, "Trade Pricing", /* @__PURE__ */ React.createElement("span", null, "Exclusive pro discounts"))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-item" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" }))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-text" }, "Expert Guidance", /* @__PURE__ */ React.createElement("span", null, "Design consultation available"))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-item" }, /* @__PURE__ */ React.createElement("div", { className: "trust-strip-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "3", width: "15", height: "13", rx: "1" }), /* @__PURE__ */ React.createElement("polyline", { points: "16 8 20 8 23 11 23 16 20 16" }), /* @__PURE__ */ React.createElement("circle", { cx: "18", cy: "18", r: "2" }), /* @__PURE__ */ React.createElement("circle", { cx: "7", cy: "18", r: "2" }))), /* @__PURE__ */ React.createElement("div", { className: "trust-strip-text" }, "Fast Shipping", /* @__PURE__ */ React.createElement("span", null, "Direct from warehouse")))))), topCats.length > 0 && /* @__PURE__ */ React.createElement(RevealSection, null, /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "Shop by Category"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our curated selection of premium surfaces"), /* @__PURE__ */ React.createElement("div", { className: "homepage-cat-grid" }, topCats.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "homepage-cat-tile", onClick: () => onCategorySelect(cat.slug) }, cat.image_url && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(cat.image_url, 500), alt: cat.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "homepage-cat-tile-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "homepage-cat-tile-name" }, cat.name), /* @__PURE__ */ React.createElement("span", { className: "homepage-cat-tile-cta" }, "Shop Now \u2192"))))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "homepage-featured-band" }, /* @__PURE__ */ React.createElement("div", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "Featured Products"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Our most popular floors, chosen by customers like you"), featuredLoading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : featuredSkus.length > 0 ? /* @__PURE__ */ React.createElement(SkuGrid, { skus: featuredSkus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }) : /* @__PURE__ */ React.createElement("p", { style: { textAlign: "center", color: "var(--stone-500)", padding: "2rem 0" } }, "Featured products coming soon.")))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "Shop the Look"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Curated collections for every style"), /* @__PURE__ */ React.createElement("div", { className: "looks-grid" }, looks.map((look) => /* @__PURE__ */ React.createElement("div", { key: look.slug, className: "look-card", onClick: () => navigate("/shop?collection=" + look.slug) }, /* @__PURE__ */ React.createElement("img", { src: thumbUrl(look.image, 400), alt: look.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "look-card-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "look-card-name" }, look.name), /* @__PURE__ */ React.createElement("span", { className: "look-card-cta" }, "Explore \u2192"))))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "Get Inspired"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Real spaces, real transformations"), /* @__PURE__ */ React.createElement("div", { className: "inspo-gallery" }, inspoImages.map((img, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "inspo-gallery-item" + (img.tall ? " tall" : ""), onClick: () => navigate("/shop?room=" + img.label.toLowerCase().replace(/\s+/g, "-")) }, /* @__PURE__ */ React.createElement("img", { src: thumbUrl(img.src, 400), alt: img.label, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "inspo-gallery-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "inspo-gallery-label" }, img.label))))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("div", { className: "homepage-cta-duo" }, /* @__PURE__ */ React.createElement("div", { className: "cta-card cta-card-dark" }, /* @__PURE__ */ React.createElement("div", { className: "cta-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" }), /* @__PURE__ */ React.createElement("polyline", { points: "3.27 6.96 12 12.01 20.73 6.96" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "22.08", x2: "12", y2: "12" }))), /* @__PURE__ */ React.createElement("h3", null, "Room Visualizer"), /* @__PURE__ */ React.createElement("p", null, "See how our floors look in your space before you buy. Upload a photo and preview any product."), /* @__PURE__ */ React.createElement("button", { className: "btn-outline", onClick: () => {
    if (window.roomvo && typeof window.roomvo.startStandaloneVisualizer === "function") {
      window.roomvo.startStandaloneVisualizer();
    } else {
      window.location.href = "/shop";
    }
  } }, "Try It Now")), /* @__PURE__ */ React.createElement("div", { className: "cta-card cta-card-light" }, /* @__PURE__ */ React.createElement("div", { className: "cta-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("path", { d: "M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }))), /* @__PURE__ */ React.createElement("h3", null, "Find Your Floor"), /* @__PURE__ */ React.createElement("p", null, "Answer a few quick questions and we'll recommend the perfect flooring for your space and style."), /* @__PURE__ */ React.createElement("button", { className: "btn-outline", onClick: onOpenQuiz }, "Take the Quiz")))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "How We Help"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "From selection to installation, we're with you every step"), /* @__PURE__ */ React.createElement("div", { className: "services-grid" }, /* @__PURE__ */ React.createElement("div", { className: "service-card", onClick: () => navigate("/design-services") }, /* @__PURE__ */ React.createElement("div", { className: "service-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 19l7-7 3 3-7 7-3-3z" }), /* @__PURE__ */ React.createElement("path", { d: "M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" }), /* @__PURE__ */ React.createElement("path", { d: "M2 2l7.586 7.586" }), /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "2" }))), /* @__PURE__ */ React.createElement("h4", null, "Design Consultation"), /* @__PURE__ */ React.createElement("p", null, "Work with our team to find the perfect material and style for your project")), /* @__PURE__ */ React.createElement("div", { className: "service-card", onClick: goBrowse }, /* @__PURE__ */ React.createElement("div", { className: "service-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "7", width: "20", height: "14", rx: "2" }), /* @__PURE__ */ React.createElement("path", { d: "M16 7V5a4 4 0 00-8 0v2" }))), /* @__PURE__ */ React.createElement("h4", null, "Free Samples"), /* @__PURE__ */ React.createElement("p", null, "Order up to 5 free samples and experience the quality in your own home")), /* @__PURE__ */ React.createElement("div", { className: "service-card", onClick: () => navigate("/installation") }, /* @__PURE__ */ React.createElement("div", { className: "service-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" }))), /* @__PURE__ */ React.createElement("h4", null, "Professional Installation"), /* @__PURE__ */ React.createElement("p", null, "Licensed installers with years of experience to ensure a perfect finish")), /* @__PURE__ */ React.createElement("div", { className: "service-card", onClick: goTrade }, /* @__PURE__ */ React.createElement("div", { className: "service-card-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "9", cy: "7", r: "4" }), /* @__PURE__ */ React.createElement("path", { d: "M23 21v-2a4 4 0 00-3-3.87" }), /* @__PURE__ */ React.createElement("path", { d: "M16 3.13a4 4 0 010 7.75" }))), /* @__PURE__ */ React.createElement("h4", null, "Trade Program"), /* @__PURE__ */ React.createElement("p", null, "Exclusive pricing and dedicated support for contractors and designers"))))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.15 }, /* @__PURE__ */ React.createElement("section", { className: "homepage-trade-band" }, /* @__PURE__ */ React.createElement("h2", null, "Trade Professional?"), /* @__PURE__ */ React.createElement("p", null, "Exclusive pricing, dedicated support, and tools built for the trade. Join our professional program."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goTrade }, "Learn More"))), /* @__PURE__ */ React.createElement(RevealSection, { delay: 0.1 }, /* @__PURE__ */ React.createElement("section", { className: "newsletter-band" }, /* @__PURE__ */ React.createElement("h2", null, "Stay in the Know"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "New arrivals, design tips, and exclusive offers delivered to your inbox"), newsletterSubmitted ? /* @__PURE__ */ React.createElement("p", { className: "newsletter-success" }, "Thank you for subscribing! Check your inbox for a welcome email.") : /* @__PURE__ */ React.createElement("form", { className: "newsletter-form", onSubmit: onNewsletterSubmit }, /* @__PURE__ */ React.createElement("input", { type: "email", placeholder: "Enter your email", value: newsletterEmail, onChange: (e) => setNewsletterEmail(e.target.value), required: true }), /* @__PURE__ */ React.createElement("button", { type: "submit" }, "Subscribe")))));
}
function SearchEmptyState({ searchQuery, categories, onSearch, onCategorySelect, didYouMean, popularTerms }) {
  const fallbackTerms = ["porcelain tile", "hardwood", "luxury vinyl", "mosaic", "marble", "carpet"];
  const suggestedTerms = popularTerms && popularTerms.length > 0 ? popularTerms.slice(0, 6) : fallbackTerms;
  return /* @__PURE__ */ React.createElement("div", { className: "search-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" })), /* @__PURE__ */ React.createElement("h2", null, 'No results for "', searchQuery, '"'), didYouMean && /* @__PURE__ */ React.createElement("p", { className: "search-empty-did-you-mean" }, "Did you mean: ", /* @__PURE__ */ React.createElement("button", { className: "search-empty-dym-link", onClick: () => onSearch(didYouMean) }, didYouMean), "?"), /* @__PURE__ */ React.createElement("p", null, "We couldn't find any products matching your search. Try one of these:"), /* @__PURE__ */ React.createElement("div", { className: "search-empty-suggestions" }, suggestedTerms.map((term) => /* @__PURE__ */ React.createElement("button", { key: term, className: "search-empty-chip", onClick: () => onSearch(term) }, term))), /* @__PURE__ */ React.createElement("p", { className: "search-empty-browse" }, "Or browse by category:"), /* @__PURE__ */ React.createElement("div", { className: "search-empty-categories" }, categories.filter((c) => !c.parent_id && c.product_count > 0).slice(0, 6).map((cat) => /* @__PURE__ */ React.createElement("button", { key: cat.slug, className: "search-empty-cat-chip", onClick: () => onCategorySelect(cat.slug) }, cat.name))));
}
function CategoryHero({ category, crumbs, searchQuery, totalSkus }) {
  if (searchQuery) {
    return /* @__PURE__ */ React.createElement("div", { className: "category-hero", style: { height: "160px" } }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: crumbs }), /* @__PURE__ */ React.createElement("h1", null, 'Search: "', searchQuery, '"'), totalSkus > 0 && /* @__PURE__ */ React.createElement("p", { className: "search-result-count" }, totalSkus, " result", totalSkus !== 1 ? "s" : ""));
  }
  const bgImage = category ? category.banner_image || category.image_url : null;
  const style = bgImage ? { backgroundImage: "url(" + bgImage + ")" } : {};
  return /* @__PURE__ */ React.createElement("div", { className: "category-hero", style }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: crumbs }), /* @__PURE__ */ React.createElement("h1", null, category ? category.name : "Shop All"), category && category.description && /* @__PURE__ */ React.createElement("p", null, category.description));
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
  onClearFilters,
  sortBy,
  onSortChange,
  onSkuClick,
  currentPage,
  onPageChange,
  wishlist,
  toggleWishlist,
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
  didYouMean
}) {
  const totalPages = Math.ceil(totalSkus / 72);
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
  if (isParentLanding && landingChildren.length === 0 && (currentCategory.children || []).length > 0) {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery, totalSkus }), /* @__PURE__ */ React.createElement("section", { className: "category-landing" }, /* @__PURE__ */ React.createElement("h2", null, currentCategory.name), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Products coming soon. Check back later!")));
  }
  if (isParentLanding && landingChildren.length > 0) {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery, totalSkus }), /* @__PURE__ */ React.createElement("section", { className: "category-landing" }, /* @__PURE__ */ React.createElement("h2", null, "Browse ", currentCategory.name), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our ", currentCategory.name.toLowerCase(), " collections"), /* @__PURE__ */ React.createElement("div", { className: "category-landing-grid" }, landingChildren.map((child) => /* @__PURE__ */ React.createElement("div", { key: child.slug, className: "category-tile", onClick: () => onCategorySelect(child.slug) }, child.image_url ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(child.image_url, 400), alt: child.name, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-200)" } }), /* @__PURE__ */ React.createElement("div", { className: "category-tile-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "category-tile-name" }, child.name), /* @__PURE__ */ React.createElement("span", { className: "category-tile-count" }, child.product_count, " products")))))));
  }
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery, totalSkus }), /* @__PURE__ */ React.createElement("div", { className: "browse-layout" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar" }, /* @__PURE__ */ React.createElement(FacetPanel, { ...facetProps })), /* @__PURE__ */ React.createElement("div", null, hasFilters && /* @__PURE__ */ React.createElement(
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
  ), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement(BrowseToolbar, { totalSkus, sortBy, onSortChange }), /* @__PURE__ */ React.createElement("button", { className: "mobile-filter-btn", onClick: () => setFilterDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("line", { x1: "4", y1: "6", x2: "20", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "8", y1: "12", x2: "20", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "18", x2: "20", y2: "18" })), "Filters", totalActiveFilterCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-badge" }, totalActiveFilterCount))), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : skus.length === 0 ? searchQuery ? /* @__PURE__ */ React.createElement(SearchEmptyState, { searchQuery, categories, onSearch, onCategorySelect, didYouMean }) : /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "1.125rem", marginBottom: "1rem" } }, "No products found"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem" } }, "Try adjusting your filters")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SkuGrid, { skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }), totalPages > 1 && /* @__PURE__ */ React.createElement(Pagination, { currentPage, totalPages, onPageChange })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-overlay" + (filterDrawerOpen ? " open" : ""), onClick: () => setFilterDrawerOpen(false) }), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer" + (filterDrawerOpen ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Filters"), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: () => setFilterDrawerOpen(false) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-body" }, /* @__PURE__ */ React.createElement(FacetPanel, { ...facetProps, isMobile: true })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-footer" }, /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, onClick: () => setFilterDrawerOpen(false) }, "Show ", totalSkus, " Result", totalSkus !== 1 ? "s" : ""))))));
}
function CategoryNav({ categories, selectedCategory, onCategorySelect }) {
  let activeParent = null;
  if (selectedCategory) {
    activeParent = categories.find((c) => c.slug === selectedCategory);
    if (!activeParent) {
      categories.forEach((p) => {
        if ((p.children || []).some((ch) => ch.slug === selectedCategory)) activeParent = p;
      });
    }
  }
  if (!activeParent || !(activeParent.children || []).length) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "category-sidebar" }, /* @__PURE__ */ React.createElement("h3", null, activeParent.name), /* @__PURE__ */ React.createElement("div", { className: "category-item" + (selectedCategory === activeParent.slug ? " active" : ""), onClick: () => onCategorySelect(activeParent.slug) }, /* @__PURE__ */ React.createElement("span", null, "All ", activeParent.name), /* @__PURE__ */ React.createElement("span", { className: "category-count" }, activeParent.product_count)), (activeParent.children || []).map((child) => /* @__PURE__ */ React.createElement("div", { key: child.slug, className: "category-item" + (selectedCategory === child.slug ? " active" : ""), onClick: () => onCategorySelect(child.slug) }, /* @__PURE__ */ React.createElement("span", null, child.name), /* @__PURE__ */ React.createElement("span", { className: "category-count" }, child.product_count))));
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
        const v = parseFloat(e.target.value) || min;
        setLocalMin(v);
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
        const v = parseFloat(e.target.value) || max;
        setLocalMax(v);
      },
      onBlur: () => commit(localMin, localMax)
    }
  ))));
}
function FacetPanel({
  facets,
  filters,
  onFilterToggle,
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
  const [collapsed, setCollapsed] = useState({});
  const [filterSearch, setFilterSearch] = useState({});
  const prioritySlugs = ["material", "finish", "size", "application"];
  const bottomSlugs = ["pei_rating", "water_absorption", "dcof", "wear_layer", "core_type", "species"];
  const chevron = (isOpen) => /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 14, height: 14, transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }));
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
    if (isActive) {
      familyRawValues.forEach((v) => {
        if (currentColors.includes(v)) onFilterToggle("color", v);
      });
    } else {
      familyRawValues.forEach((v) => {
        if (!currentColors.includes(v)) onFilterToggle("color", v);
      });
    }
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
  const renderFilterGroup = (group) => {
    const isCol = isGroupCollapsed(group.slug);
    const searchTerm = filterSearch[group.slug] || "";
    const values = searchTerm ? group.values.filter((v) => v.value.toLowerCase().includes(searchTerm.toLowerCase())) : group.values;
    const activeCount = (filters[group.slug] || []).length;
    const checkId = (val) => "f-" + group.slug + "-" + val.replace(/[^a-zA-Z0-9]/g, "_");
    return /* @__PURE__ */ React.createElement("div", { key: group.slug, className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, [group.slug]: !isCol })) }, /* @__PURE__ */ React.createElement("span", null, group.name, activeCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, activeCount)), chevron(!isCol)), !isCol && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.625rem" } }, group.values.length > 15 && /* @__PURE__ */ React.createElement(
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
      return /* @__PURE__ */ React.createElement("div", { key: v.value, className: "filter-option" }, /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "checkbox",
          id: checkId(v.value),
          checked,
          onChange: () => onFilterToggle(group.slug, v.value)
        }
      ), /* @__PURE__ */ React.createElement("label", { htmlFor: checkId(v.value) }, formatCarpetValue(v.value)), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
    }), values.length === 0 && searchTerm && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-400)", padding: "0.25rem 0" } }, "No matches"))));
  };
  return /* @__PURE__ */ React.createElement("div", { className: "filter-panel" }, /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: "0.75rem", borderBottom: "1px solid var(--stone-200)", marginBottom: "0.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--stone-900)" } }, "Filters"), hasAny && /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear All")), vendors && vendors.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "filter-group vendor-filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, _vendor: !prev._vendor })) }, /* @__PURE__ */ React.createElement("span", null, "Brand", hasVendorFilters && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, vendorFilters.length)), chevron(collapsed._vendor)), !collapsed._vendor && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.625rem" } }, vendors.length > 15 && /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "filter-search-input",
      type: "text",
      placeholder: "Search brands...",
      value: filterSearch._vendor || "",
      onChange: (e) => setFilterSearch((prev) => ({ ...prev, _vendor: e.target.value })),
      onClick: (e) => e.stopPropagation()
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "filter-values-scroll" }, (filterSearch._vendor ? vendors.filter((v) => v.name.toLowerCase().includes(filterSearch._vendor.toLowerCase())) : vendors).map((v) => {
    const checked = vendorFilters.includes(v.name);
    return /* @__PURE__ */ React.createElement("div", { key: v.name, className: "filter-option" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "checkbox",
        id: "f-vendor-" + v.name.replace(/[^a-zA-Z0-9]/g, "_"),
        checked,
        onChange: () => onVendorToggle(v.name)
      }
    ), /* @__PURE__ */ React.createElement("label", { htmlFor: "f-vendor-" + v.name.replace(/[^a-zA-Z0-9]/g, "_") }, v.name), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
  })))), tagFacets && tagFacets.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title" }, /* @__PURE__ */ React.createElement("span", null, "Features & Room", hasTagFilters && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, tagFilters.length))), /* @__PURE__ */ React.createElement("div", { className: "tag-chips" }, tagFacets.map((tag) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: tag.slug,
      className: "tag-chip" + ((tagFilters || []).includes(tag.slug) ? " active" : ""),
      onClick: () => onTagToggle(tag.slug)
    },
    tag.name,
    " ",
    /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", tag.count, ")")
  )))), priceRange && priceRange.max > 0 && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, _price: !prev._price })) }, /* @__PURE__ */ React.createElement("span", null, "Price", hasPriceFilters && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, "1")), chevron(collapsed._price)), !collapsed._price && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.625rem" } }, /* @__PURE__ */ React.createElement(PriceRangeFilter, { priceRange, userPriceRange: userPriceRange || { min: null, max: null }, onChange: onPriceRangeChange }))), colorFacet && /* @__PURE__ */ React.createElement("div", { className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, color: !isGroupCollapsed("color") })) }, /* @__PURE__ */ React.createElement("span", null, "Color", (filters.color || []).length > 0 && /* @__PURE__ */ React.createElement("span", { className: "filter-group-count-badge" }, (filters.color || []).length)), chevron(isGroupCollapsed("color"))), !isGroupCollapsed("color") && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.625rem" } }, /* @__PURE__ */ React.createElement("div", { className: "color-family-grid" }, Object.entries(COLOR_FAMILIES).map(([name, { hex }]) => {
    if (!familyCounts[name]) return null;
    const isActive = activeFamilies.includes(name);
    const style = hex.includes("gradient") ? { background: hex } : { backgroundColor: hex };
    return /* @__PURE__ */ React.createElement("div", { key: name, className: "color-family-swatch" + (isActive ? " active" : ""), onClick: () => handleFamilyClick(name) }, /* @__PURE__ */ React.createElement("div", { className: "color-family-circle", style }), /* @__PURE__ */ React.createElement("span", { className: "color-family-name" }, name));
  })), colorFacet.values.length > 15 && /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "filter-search-input",
      type: "text",
      placeholder: "Search colors...",
      value: filterSearch.color || "",
      onChange: (e) => setFilterSearch((prev) => ({ ...prev, color: e.target.value })),
      onClick: (e) => e.stopPropagation()
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "filter-values-scroll" }, (filterSearch.color ? colorFacet.values.filter((v) => v.value.toLowerCase().includes(filterSearch.color.toLowerCase())) : colorFacet.values).map((v) => {
    const checked = (filters.color || []).includes(v.value);
    return /* @__PURE__ */ React.createElement("div", { key: v.value, className: "filter-option" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "checkbox",
        id: "f-color-" + v.value.replace(/[^a-zA-Z0-9]/g, "_"),
        checked,
        onChange: () => onFilterToggle("color", v.value)
      }
    ), /* @__PURE__ */ React.createElement("label", { htmlFor: "f-color-" + v.value.replace(/[^a-zA-Z0-9]/g, "_") }, formatCarpetValue(v.value)), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
  })))), sortedFacets.map((group) => renderFilterGroup(group)));
}
function ActiveFilterPills({ filters, facets, onFilterToggle, onClearFilters, vendorFilters, onVendorToggle, userPriceRange, onPriceRangeChange, tagFilters, tagFacets, onTagToggle }) {
  const pills = [];
  (vendorFilters || []).forEach((name) => {
    pills.push({ type: "vendor", value: name, label: "Brand: " + name, onRemove: () => onVendorToggle(name) });
  });
  (tagFilters || []).forEach((slug) => {
    const tag = (tagFacets || []).find((t) => t.slug === slug);
    pills.push({ type: "tag", value: slug, label: tag ? tag.name : slug, onRemove: () => onTagToggle(slug) });
  });
  if (userPriceRange && (userPriceRange.min != null || userPriceRange.max != null)) {
    const label = "Price: $" + (userPriceRange.min || 0) + " \u2013 $" + (userPriceRange.max || "\u221E");
    pills.push({ type: "price", value: "price", label, onRemove: () => onPriceRangeChange(null, null) });
  }
  Object.keys(filters).forEach((slug) => {
    const group = facets.find((f) => f.slug === slug);
    const name = group ? group.name : slug;
    (filters[slug] || []).forEach((val) => {
      pills.push({ type: "attr", slug, value: val, label: name + ": " + val, onRemove: () => onFilterToggle(slug, val) });
    });
  });
  if (pills.length === 0) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "active-filters" }, pills.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "filter-pill" }, /* @__PURE__ */ React.createElement("span", null, p.label), /* @__PURE__ */ React.createElement("button", { onClick: p.onRemove }, "\xD7"))), /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear All"));
}
function BrowseToolbar({ totalSkus, sortBy, onSortChange }) {
  return /* @__PURE__ */ React.createElement("div", { className: "browse-toolbar" }, /* @__PURE__ */ React.createElement("div", { className: "result-count" }, totalSkus, " product", totalSkus !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("select", { value: sortBy, onChange: (e) => onSortChange(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "name_asc" }, "Name A-Z"), /* @__PURE__ */ React.createElement("option", { value: "name_desc" }, "Name Z-A"), /* @__PURE__ */ React.createElement("option", { value: "price_asc" }, "Price: Low to High"), /* @__PURE__ */ React.createElement("option", { value: "price_desc" }, "Price: High to Low"), /* @__PURE__ */ React.createElement("option", { value: "newest" }, "Newest")));
}
function SkeletonGrid({ count = 8 }) {
  return /* @__PURE__ */ React.createElement("div", { className: "skeleton-grid" }, Array.from({ length: count }, (_, i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-card-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" }))));
}
function SkuGrid({ skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }) {
  return /* @__PURE__ */ React.createElement("div", { className: "sku-grid" }, skus.map((sku) => /* @__PURE__ */ React.createElement(
    SkuCard,
    {
      key: sku.sku_id,
      sku,
      onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection, sku.category_slug, sku.product_slug),
      isWished: wishlist.includes(sku.product_id),
      onToggleWishlist: () => toggleWishlist(sku.product_id),
      onQuickView: setQuickViewSku ? () => setQuickViewSku(sku) : null
    }
  )));
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
  return /* @__PURE__ */ React.createElement("nav", { className: "pagination", "aria-label": "Product pages" }, /* @__PURE__ */ React.createElement("button", { className: "pagination-btn", disabled: currentPage <= 1, onClick: () => onPageChange(currentPage - 1) }, "\u2190 Previous"), /* @__PURE__ */ React.createElement("div", { className: "pagination-pages" }, pages.map((p, i) => p === "..." ? /* @__PURE__ */ React.createElement("span", { key: "e" + i, className: "pagination-ellipsis" }, "\u2026") : /* @__PURE__ */ React.createElement("button", { key: p, className: "pagination-num" + (p === currentPage ? " active" : ""), onClick: () => onPageChange(p) }, p))), /* @__PURE__ */ React.createElement("button", { className: "pagination-btn", disabled: currentPage >= totalPages, onClick: () => onPageChange(currentPage + 1) }, "Next \u2192"));
}
function SkuCard({ sku, onClick, isWished, onToggleWishlist, onQuickView }) {
  const onSale = sku.sale_price != null && !sku.trade_price;
  const price = sku.trade_price || (onSale ? sku.sale_price : sku.retail_price);
  const discountPct = onSale && sku.retail_price ? Math.round((1 - parseFloat(sku.sale_price) / parseFloat(sku.retail_price)) * 100) : 0;
  return /* @__PURE__ */ React.createElement("div", { className: "sku-card", onClick, "data-sku": sku.vendor_sku || sku.internal_sku }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "wishlist-heart" + (isWished ? " active" : ""),
      onClick: (e) => {
        e.stopPropagation();
        onToggleWishlist();
      }
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: isWished ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" }))
  ), /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, /* @__PURE__ */ React.createElement("img", { src: sku.primary_image ? thumbUrl(sku.primary_image, 400) : PLACEHOLDER_SVG, alt: sku.product_name, loading: "lazy", decoding: "async", width: "300", height: "300", onError: handleImgError }), sku.alternate_image && /* @__PURE__ */ React.createElement("img", { className: "sku-card-alt-img", src: thumbUrl(sku.alternate_image, 400), alt: "", loading: "lazy", decoding: "async", width: "300", height: "300", onError: handleImgError }), onSale && /* @__PURE__ */ React.createElement("span", { className: "sale-badge" }, "SALE"), onQuickView && /* @__PURE__ */ React.createElement("button", { className: "quick-view-btn", onClick: (e) => {
    e.stopPropagation();
    onQuickView();
  } }, "Quick View")), sku.vendor_has_inventory !== false && sku.stock_status === "low_stock" && /* @__PURE__ */ React.createElement("span", { className: "stock-badge stock-badge--low_stock", style: { fontSize: "0.6875rem", padding: "0.125rem 0.5rem", marginBottom: "0.25rem", display: "inline-block" } }, "Low Stock"), sku.vendor_has_inventory !== false && sku.stock_status === "out_of_stock" && /* @__PURE__ */ React.createElement("span", { className: "stock-badge stock-badge--out_of_stock", style: { fontSize: "0.6875rem", padding: "0.125rem 0.5rem", marginBottom: "0.25rem", display: "inline-block" } }, "Out of Stock"), /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, fullProductName(sku)), sku.vendor_name && /* @__PURE__ */ React.createElement("div", { className: "sku-card-vendor" }, sku.vendor_name), /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, price ? /* @__PURE__ */ React.createElement(React.Fragment, null, sku.trade_price && sku.retail_price && /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "0.875rem", marginRight: "0.5rem" } }, "$", displayPrice(sku, sku.retail_price).toFixed(2)), onSale && /* @__PURE__ */ React.createElement("span", { className: "sale-original-price" }, "$", displayPrice(sku, sku.retail_price).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: onSale ? "sale-price-text" : "" }, "$", displayPrice(sku, price).toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "price-suffix" }, priceSuffix(sku)), onSale && discountPct > 0 && /* @__PURE__ */ React.createElement("span", { className: "sale-discount-tag" }, discountPct, "% off")) : "Contact for pricing"));
}
function SkuDetailView({ skuId, categorySlug, productSlug, goBack, addToCart, cart, onSkuClick, onRequestInstall, tradeCustomer, wishlist, toggleWishlist, recentlyViewed, addRecentlyViewed, customer, customerToken, onShowAuth, showToast, categories }) {
  const [sku, setSku] = useState(null);
  const [media, setMedia] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const [crossAccessories, setCrossAccessories] = useState([]);
  const [collectionSiblings, setCollectionSiblings] = useState([]);
  const [collectionAttributes, setCollectionAttributes] = useState({});
  const [groupedProducts, setGroupedProducts] = useState([]);
  const [productTags, setProductTags] = useState([]);
  const [countertopImage, setCountertopImage] = useState(null);
  const [selectedImage, setSelectedImage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
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
  useEffect(() => {
    setLoading(true);
    setSelectedImage(0);
    setAccessoryQtys({});
    const headers = {};
    const t = localStorage.getItem("trade_token");
    if (t) headers["X-Trade-Token"] = t;
    const doFetch = (id) => {
      fetch(API + "/api/storefront/skus/" + id, { headers }).then((r) => {
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
      setCrossAccessories(data.cross_product_accessories || []);
      setCollectionSiblings(data.collection_siblings || []);
      setCollectionAttributes(data.collection_attributes || {});
      setGroupedProducts(data.grouped_products || []);
      setCountertopImage(data.countertop_image || null);
      setProductTags(data.tags || []);
      setLoading(false);
      if (data.sku && addRecentlyViewed) {
        addRecentlyViewed({ sku_id: data.sku.sku_id, product_name: data.sku.product_name, variant_name: data.sku.variant_name, primary_image: data.media && data.media[0] ? data.media[0].url : null, retail_price: data.sku.retail_price, price_basis: data.sku.price_basis, sell_by: data.sku.sell_by, sqft_per_box: data.sku.sqft_per_box });
      }
      if (data.sku) {
        const skuTitle = fullProductName(data.sku) + " | Roma Flooring Designs";
        const skuDesc = cleanDescription(data.sku.description_short, data.sku.vendor_name) || "Premium " + data.sku.product_name + " from Roma Flooring Designs";
        const skuImage = data.media && data.media[0] ? data.media[0].url : null;
        const seoUrl = (data.sku.category_slug && data.sku.product_slug)
          ? SITE_URL + "/shop/" + data.sku.category_slug + "/" + data.sku.product_slug
          : SITE_URL + "/shop/sku/" + (skuId || data.sku.sku_id);
        updateSEO({ title: skuTitle, description: skuDesc, url: seoUrl, image: skuImage });
        fetch(API + "/api/storefront/products/" + data.sku.product_id + "/reviews").then((r) => r.json()).then((revData) => {
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
            fetch(API + "/api/storefront/stock-alerts/check?sku_id=" + data.sku.sku_id + "&email=" + encodeURIComponent(alertEmail2)).then((r) => r.json()).then((d) => {
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
    };
    if (skuId) {
      doFetch(skuId);
    } else if (categorySlug && productSlug) {
      fetch(API + "/api/storefront/products/" + categorySlug + "/" + productSlug).then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "not_found" : "server_error");
        return r.json();
      }).then((data) => {
        if (data.resolve_sku_id) {
          doFetch(data.resolve_sku_id);
        } else {
          setFetchError("not_found");
          setLoading(false);
        }
      }).catch((err) => {
        console.error(err);
        setFetchError(err.message === "not_found" ? "not_found" : "error");
        setLoading(false);
      });
    }
  }, [skuId, categorySlug, productSlug]);
  useEffect(() => {
    if (!sku) return;
    const skuDesc = cleanDescription(sku.description_short, sku.vendor_name) || "Premium " + sku.product_name + " from Roma Flooring Designs";
    const skuImage = media && media[0] ? media[0].url : null;
    const product = {
      "@type": "Product",
      name: fullProductName(sku),
      description: skuDesc,
      image: skuImage,
      sku: sku.sku_code || String(sku.sku_id),
      mpn: sku.sku_code || "",
      brand: { "@type": "Brand", name: sku.vendor_name || "Roma Flooring Designs" },
      category: sku.category_name || "",
      offers: {
        "@type": "Offer",
        url: (sku.category_slug && sku.product_slug) ? SITE_URL + "/shop/" + sku.category_slug + "/" + sku.product_slug : SITE_URL + "/shop/sku/" + (skuId || sku.sku_id),
        priceCurrency: "USD",
        price: displayPrice(sku, sku.sale_price || sku.retail_price).toFixed(2),
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
        { "@type": "ListItem", position: sku.category_name ? 4 : 3, name: fullProductName(sku), item: (sku.category_slug && sku.product_slug) ? SITE_URL + "/shop/" + sku.category_slug + "/" + sku.product_slug : SITE_URL + "/shop/sku/" + (skuId || sku.sku_id) }
      ].filter(Boolean) }
    ] });
  }, [sku, media, avgRating, reviewCount]);
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
  const effectiveCarpetMode = carpetInputMode === "linear" && rollWidthFt <= 0 ? "dimensions" : carpetInputMode;
  const carpetRawSqft = isCarpetSku ? effectiveCarpetMode === "linear" ? rollWidthFt * (parseFloat(linearFeet) || 0) : effectiveCarpetMode === "dimensions" ? (parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0) : parseFloat(sqftInput) || 0 : 0;
  const carpetSqft = includeCarpetOverage ? Math.ceil(carpetRawSqft * 1.1) : carpetRawSqft;
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
  const piecesPerBox = sku ? parseFloat(sku.pieces_per_box) || 0 : 0;
  const sqftPerPiece = piecesPerBox > 0 && sqftPerBox > 0 ? sqftPerBox / piecesPerBox : 0;
  const hasBoxCalc = !isPerUnit && sqftPerBox > 0;
  const isSqftNoBox = !isPerUnit && sqftPerBox <= 0;
  const isBackorder = sku && sku.stock_status === "out_of_stock" && sku.vendor_has_inventory !== false;
  const unitSubtotal = unitQty * effectivePrice;
  const sqftOnlySubtotal = (parseFloat(sqftInput) || 0) * effectivePrice;
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
        sell_by: "sqyd",
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
        sell_by: "unit"
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
        sell_by: "sqft"
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
        sell_by: "sqft"
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
  } }, /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Search for products...", value: notFoundSearch, onChange: (e) => setNotFoundSearch(e.target.value) }), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn" }, "Search")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: goBack, style: { marginTop: "1rem" } }, "Back to Shop")), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: rv.primary_image ? thumbUrl(rv.primary_image, 200) : PLACEHOLDER_SVG, alt: rv.product_name, loading: "lazy", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(rv)), rv.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(rv, rv.retail_price).toFixed(2), priceSuffix(rv)))))), fetchError === "not_found" && categories && categories.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2.5rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Popular Categories"), /* @__PURE__ */ React.createElement("div", { className: "not-found-cats" }, categories.slice(0, 8).map((cat) => /* @__PURE__ */ React.createElement("a", { key: cat.slug, className: "not-found-cat-link", onClick: () => {
    goBack();
  } }, cat.name)))));
  if (loading) return /* @__PURE__ */ React.createElement("div", { className: "sku-detail", style: { minHeight: "80vh" } }, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 12, background: "var(--stone-100)", borderRadius: 2 } }), /* @__PURE__ */ React.createElement("div", { style: { width: 80, height: 12, background: "var(--stone-100)", borderRadius: 2 } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery" }, /* @__PURE__ */ React.createElement("div", { style: { width: "100%", paddingBottom: "100%", background: "var(--stone-100)", animation: "pulse 1.5s ease-in-out infinite" } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info" }, /* @__PURE__ */ React.createElement("div", { style: { width: "40%", height: 16, background: "var(--stone-100)", borderRadius: 2, marginBottom: "1rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "70%", height: 32, background: "var(--stone-100)", borderRadius: 2, marginBottom: "0.75rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "50%", height: 14, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "30%", height: 28, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: 200, background: "var(--stone-50)", borderRadius: 2 } }))));
  if (!sku) return /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "6rem", color: "var(--stone-600)" } }, "SKU not found");
  const images = media.filter((m) => m.asset_type !== "spec_pdf");
  const specPdfs = media.filter((m) => m.asset_type === "spec_pdf");
  const mainImage = images[selectedImage] || images[0];
  const mainSiblings = siblings.filter((s) => s.variant_type !== "accessory");
  const accessorySiblings = [
    ...siblings.filter((s) => s.variant_type === "accessory"),
    ...(crossAccessories || [])
  ];
  const isAdexProduct = /adex/i.test(sku.vendor_name || "");
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sku-detail", "data-sku": sku.vendor_sku || sku.internal_sku }, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("a", { onClick: goBack }, "Shop"), /* @__PURE__ */ React.createElement("span", null, "/"), sku.category_name && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("a", { onClick: goBack }, sku.category_name), /* @__PURE__ */ React.createElement("span", null, "/")), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-800)" } }, fullProductName(sku))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-image" }, mainImage ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(mainImage.url, 1e3), alt: sku.product_name, decoding: "async", onError: handleImgError }) : /* @__PURE__ */ React.createElement("img", { src: PLACEHOLDER_SVG, alt: sku.product_name })), images.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "gallery-thumbs" }, images.map((img, i) => /* @__PURE__ */ React.createElement("div", { key: img.id, className: "gallery-thumb" + (i === selectedImage ? " active" : ""), onClick: () => setSelectedImage(i) }, /* @__PURE__ */ React.createElement("img", { src: thumbUrl(img.url, 100), alt: "", loading: "lazy", decoding: "async", width: "80", height: "80", onError: handleImgError })))), (() => {
    const HIDDEN_SLUGS = /* @__PURE__ */ new Set(["price_list", "material_class", "style_code", "companion_skus", "subcategory", "brand", "msrp", "top_ref_sku", "sink_ref_sku", "optional_accessories", "group_number", "upc"]);
    const ORDER = ["_collection", "_category", "collection", "species", "color", "color_code", "application", "fiber", "material", "core_type", "construction", "finish", "style", "pattern", "size", "thickness", "width", "wear_layer", "edge_type", "rectified", "pei_rating", "dcof", "water_absorption", "shade_variation", "installation_method", "radiant_heat", "certification", "country", "weight", "weight_per_sqyd", "roll_width", "roll_length"];
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
    if (sku.collection && !slugMap.collection) {
      sorted.unshift({ slug: "_collection", name: "Collection", value: sku.collection });
    }
    if (sku.category_name) {
      const insertIdx = sorted.findIndex((a) => a.slug === "_collection") >= 0 ? 1 : 0;
      sorted.splice(insertIdx, 0, { slug: "_category", name: "Category", value: sku.category_name });
    }
    const priceListAttr = (sku.attributes || []).find((a) => a.slug === "price_list");
    if (priceListAttr && priceListAttr.value) {
      const brandLine = priceListAttr.value.replace(/\s+\d+$/, "");
      const ccIdx = sorted.findIndex((a) => a.slug === "color_code");
      sorted.splice(ccIdx >= 0 ? ccIdx + 1 : sorted.length, 0, { slug: "_brand", name: "Brand", value: brandLine });
    }
    if (sorted.length === 0) return null;
    const PEI_LABELS = { '1': 'Light Traffic', '2': 'Moderate Traffic', '3': 'Medium Traffic', '4': 'Heavy Traffic', '5': 'Extra Heavy Traffic' };
    const formatSpecValue = (slug, val) => {
      if (slug === 'certification' && val && val.includes(',')) {
        return React.createElement('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.375rem' } }, val.split(',').map((c, i) => React.createElement('span', { key: i, className: 'install-badge' }, c.trim())));
      }
      if (slug === 'rectified' && /yes/i.test(val)) return 'Yes (Rectified)';
      if (slug === 'radiant_heat' && /yes/i.test(val)) return 'Compatible';
      if (slug === 'pei_rating') {
        const n = val.replace(/[^0-9]/g, '');
        if (PEI_LABELS[n]) return val + ' (' + PEI_LABELS[n] + ')';
      }
      return formatCarpetValue(val);
    };
    const SPEC_GROUPS = {
      'General': ['_collection', '_category', '_brand', 'collection', 'material', 'core_type', 'species', 'color', 'color_code', 'style', 'pattern', 'look'],
      'Dimensions': ['size', 'thickness', 'width', 'wear_layer', 'weight', 'weight_per_sqyd', 'roll_width', 'roll_length'],
      'Surface & Finish': ['finish', 'edge_type', 'rectified', 'shade_variation'],
      'Performance': ['pei_rating', 'dcof', 'water_absorption', 'application'],
      'Installation': ['installation_method', 'subfloor_requirements', 'acclimation_time', 'expansion_gap', 'radiant_heat'],
      'Details': ['certification', 'country', 'fiber', 'construction']
    };
    const slugSet = new Set(sorted.map((a) => a.slug));
    const groupsWithData = Object.entries(SPEC_GROUPS).filter(([, slugs]) => slugs.some((s) => slugSet.has(s)));
    if (groupsWithData.length < 2) {
      return React.createElement("table", { className: "specs-table" }, React.createElement("tbody", null, sorted.map((a, i) => React.createElement("tr", { key: i }, React.createElement("td", null, a.name), React.createElement("td", null, formatSpecValue(a.slug, a.value))))));
    }
    const placed = new Set();
    const groupElements = groupsWithData.map(([label, slugs]) => {
      const rows = slugs.map((s) => sorted.find((a) => a.slug === s)).filter(Boolean).filter((a) => !placed.has(a.slug));
      rows.forEach((a) => placed.add(a.slug));
      if (rows.length === 0) return null;
      return React.createElement("div", { key: label, className: "specs-category" }, React.createElement("div", { className: "specs-category-header" }, label), React.createElement("table", { className: "specs-table" }, React.createElement("tbody", null, rows.map((a, i) => React.createElement("tr", { key: i }, React.createElement("td", null, a.name), React.createElement("td", null, formatSpecValue(a.slug, a.value)))))));
    }).filter(Boolean);
    const remaining = sorted.filter((a) => !placed.has(a.slug));
    if (remaining.length > 0) {
      groupElements.push(React.createElement("div", { key: "other", className: "specs-category" }, React.createElement("div", { className: "specs-category-header" }, "Other"), React.createElement("table", { className: "specs-table" }, React.createElement("tbody", null, remaining.map((a, i) => React.createElement("tr", { key: i }, React.createElement("td", null, a.name), React.createElement("td", null, formatSpecValue(a.slug, a.value))))))));
    }
    return React.createElement("div", { className: "specs-categorized" }, groupElements);
  })(), (sku.description_long || sku.description_short) && (() => {
    const cleaned = cleanDescription(sku.description_long || sku.description_short, sku.vendor_name);
    return cleaned ? /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1rem", fontSize: "0.9rem", lineHeight: 1.7, color: "var(--stone-600)" } }, cleaned) : null;
  })(), specPdfs.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1.5rem", paddingTop: "1.5rem", borderTop: "1px solid var(--stone-200)" } }, specPdfs.map((pdf) => /* @__PURE__ */ React.createElement(
    "a",
    {
      key: pdf.id,
      href: pdf.url,
      target: "_blank",
      rel: "noopener noreferrer",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.6rem 1rem",
        border: "1px solid var(--stone-200)",
        fontSize: "0.8125rem",
        color: "var(--stone-800)",
        textDecoration: "none",
        transition: "border-color 0.2s",
        marginRight: "0.5rem",
        marginBottom: "0.5rem"
      },
      onMouseOver: (e) => e.currentTarget.style.borderColor = "var(--gold)",
      onMouseOut: (e) => e.currentTarget.style.borderColor = "var(--stone-200)"
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 16, height: 16, flexShrink: 0 } }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "18", x2: "12", y2: "12" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 15 12 18 15 15" })),
    pdf.alt_text || "Spec Sheet (PDF)"
  )))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info" }, /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goBack }, "\u2190 Back to Shop"), /* @__PURE__ */ React.createElement("h1", { className: "sku-detail-title-row" }, fullProductName(sku)), productTags.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "product-tag-badges" }, productTags.map((t) => /* @__PURE__ */ React.createElement("span", { key: t.slug, className: "product-tag-badge" }, t.name))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-price" }, isCarpet(sku) ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "1.75rem", fontWeight: 600 } }, "$", parseFloat(sku.cut_price).toFixed(2)), /* @__PURE__ */ React.createElement("span", null, "/sqyd"), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginLeft: "0.5rem" } }, "($", carpetSqftPrice(sku.cut_price), "/sqft)")), sku.roll_price && parseFloat(sku.roll_price) < parseFloat(sku.cut_price) && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.875rem", color: "var(--sage)", marginTop: "0.375rem" } }, "Roll Price: $", parseFloat(sku.roll_price).toFixed(2), "/sqyd ($", carpetSqftPrice(sku.roll_price), "/sqft)", sku.roll_min_sqft && /* @__PURE__ */ React.createElement("span", null, " \u2014 orders over ", parseFloat(sku.roll_min_sqft).toFixed(0), " sqft")), tradePrice && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--gold)", marginTop: "0.25rem" } }, "Trade Price (", sku.trade_tier, ")")) : tradePrice ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "1.25rem", marginRight: "0.5rem" } }, "$", retailPrice.toFixed(2)), "$", tradePrice.toFixed(2), /* @__PURE__ */ React.createElement("span", null, priceSuffix(sku)), isPerUnit && sqftPerPiece > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginLeft: "0.5rem" } }, "($", (tradePrice / sqftPerPiece).toFixed(2), "/sqft)"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--gold)", marginTop: "0.25rem" } }, "Trade Price (", sku.trade_tier, ")")) : salePrice ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { className: "sale-original-price", style: { fontSize: "1.25rem" } }, "$", retailPrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", { className: "sale-price-text", style: { fontSize: "1.75rem", fontWeight: 600 } }, "$", salePrice.toFixed(2)), /* @__PURE__ */ React.createElement("span", null, priceSuffix(sku)), isPerUnit && sqftPerPiece > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginLeft: "0.5rem" } }, "($", (salePrice / sqftPerPiece).toFixed(2), "/sqft)"), /* @__PURE__ */ React.createElement("span", { className: "sale-discount-tag" }, Math.round((1 - salePrice / retailPrice) * 100), "% off")) : retailPrice > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, "$", retailPrice.toFixed(2), /* @__PURE__ */ React.createElement("span", null, priceSuffix(sku)), isPerUnit && sqftPerPiece > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginLeft: "0.5rem" } }, "($", (retailPrice / sqftPerPiece).toFixed(2), "/sqft \u00B7 ", sqftPerBox, " sqft/box)")) : "Contact for pricing"), (() => {
    const klarnaAmt = isCarpet(sku) ? Math.round(parseFloat(sku.cut_price || 0) * 100) : Math.round(effectivePrice * 100);
    return klarnaAmt >= 3500 ? React.createElement(KlarnaMessage, { amountCents: klarnaAmt }) : null;
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
      allCollection.push({
        sku_id: sku.sku_id,
        product_name: sku.product_name,
        variant_name: sku.variant_name,
        primary_image: curSkuPrimary ? curSkuPrimary.url : null,
        color: curColor,
        finish: curFinish
      });
      seenIds.add(sku.sku_id);
      mainSiblings.forEach((s) => {
        if (seenIds.has(s.sku_id)) return;
        seenIds.add(s.sku_id);
        const ca = (s.attributes || []).find((a) => a.slug === "color");
        const fa = (s.attributes || []).find((a) => a.slug === "finish");
        allCollection.push({ ...s, product_name: sku.product_name, color: ca ? ca.value : "", finish: fa ? fa.value : "", primary_image: s.sku_image || null });
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
          const rep = sameProductFinish.find((s) => s.color === color);
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
        } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (c.is_current ? " active" : "") }, c.primary_image ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(c.primary_image, 80), alt: c.color, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.625rem", fontWeight: 600, color: "var(--stone-500)", textAlign: "center", lineHeight: 1.2, padding: "4px" } }, c.color)), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, c.color))))), showFinishRow && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Finish", /* @__PURE__ */ React.createElement("span", null, curFinish || "Standard")), /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, finishesForColor.map((f) => {
          const isActive = f === curFinish;
          const match = sameProductColor.find((s) => s.finish === f) || allCollection.find((s) => s.color === curColor && s.finish === f && s.product_name === sku.product_name);
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
            if (/^End Cap|^Frame Corner|^Beak|^FE Corner/i.test(prefix)) return s.product_name + " \u2014 " + prefix;
            return s.product_name;
          };
          const groups = {};
          matchingVariants.forEach((s) => {
            const cat = categorize(s.product_name || "", s.variant_name || "");
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(s);
          });
          const CATEGORY_ORDER = ["Field Tiles", "Beveled Tiles", "Decorative Accessories", "Decorative Accents", "Finishing Edges", "Bullnoses", "Glazed Edges", "Moldings & Trim", "Finishing Touches", "Other Pieces"];
          const orderedGroups = CATEGORY_ORDER.filter((cat) => groups[cat] && groups[cat].length > 0);
          return /* @__PURE__ */ React.createElement("div", { style: { marginTop: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label", style: { marginBottom: "0.75rem" } }, curColor, curFinish ? " " + curFinish : "", " \u2014 ", sku.collection, " Collection", /* @__PURE__ */ React.createElement("span", null, matchingVariants.length, " pieces")), orderedGroups.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat, style: { marginBottom: "1.25rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--stone-500)", marginBottom: "0.5rem" } }, cat), /* @__PURE__ */ React.createElement("div", { className: "variant-grid" }, groups[cat].map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, (s.shape_image || s.primary_image) && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(s.shape_image || s.primary_image, 80), alt: displayName(s), loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, displayName(s)), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(s, s.retail_price).toFixed(2), priceSuffix(s))))))));
        })());
      }
    }
    const colorItems = collectionSiblings.length > 0 ? [
      { sku_id: sku.sku_id, product_name: sku.product_name, primary_image: media && media[0] ? media[0].url : null, is_current: true, color: ((sku.attributes || []).find((a) => a.slug === "color") || {}).value || "" },
      ...collectionSiblings
    ] : [];
    const attrMap = {};
    const caData = collectionAttributes || {};
    Object.keys(caData).forEach((slug) => {
      attrMap[slug] = { name: caData[slug].name, values: new Set(caData[slug].values || []) };
    });
    allSiblings.forEach((s) => {
      (s.attributes || []).forEach((a) => {
        if (!attrMap[a.slug]) attrMap[a.slug] = { name: a.name, values: /* @__PURE__ */ new Set() };
        attrMap[a.slug].values.add(a.value);
      });
    });
    const NON_SELECTABLE = /* @__PURE__ */ new Set(["pei_rating", "shade_variation", "water_absorption", "dcof", "material", "country", "application", "edge", "look", "color", "color_code", "style_code", "price_list", "companion_skus", "species", "subcategory", "upc", "msrp", "weight", "top_ref_sku", "sink_ref_sku", "optional_accessories", "group_number", "width", "height", "depth", "hardware_finish", "num_drawers", "num_doors", "num_shelves", "num_sinks", "soft_close", "sink_material", "sink_type", "vanity_type", "bowl_shape", "style", "origin", "countertop_material", "thickness", "construction", "wear_layer", "core_type", "certification", "rectified", "edge_type", "installation_method", "radiant_heat", "pattern", "weight_per_sqyd", "roll_width", "roll_length", "fiber"]);
    const localAttrCounts = {};
    allSiblings.forEach((s) => {
      (s.attributes || []).forEach((a) => {
        if (!localAttrCounts[a.slug]) localAttrCounts[a.slug] = /* @__PURE__ */ new Set();
        localAttrCounts[a.slug].add(a.value);
      });
    });
    const attrSlugs = Object.keys(attrMap).filter((slug) => localAttrCounts[slug] && localAttrCounts[slug].size > 1 && !NON_SELECTABLE.has(slug)).sort((a, b) => a === "finish" ? -1 : b === "finish" ? 1 : 0);
    const sizeSort = (a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    };
    const showColors = colorItems.length >= 2;
    const isRomanVariants = showColors && colorItems.some((c) => hasRomanSuffix(c.product_name));
    const colorLabel = attrMap["countertop_finish"] ? "Size" : isRomanVariants ? "Style" : "Color";
    const showAttrs = attrSlugs.length > 0;
    if (!showColors && !showAttrs) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "variant-selectors" }, showColors && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, colorLabel), isRomanVariants ? /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, [...colorItems].sort((a, b) => romanSortKey(a.product_name) - romanSortKey(b.product_name)).map((c) => /* @__PURE__ */ React.createElement("button", { key: c.sku_id, className: "attr-pill" + (c.is_current ? " active" : ""), onClick: () => {
      if (!c.is_current) onSkuClick(c.sku_id);
    } }, c.product_name))) : /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, colorItems.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.sku_id, className: "color-swatch-wrap", onClick: () => {
      if (!c.is_current) onSkuClick(c.sku_id);
    } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (c.is_current ? " active" : "") }, c.primary_image ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(c.primary_image, 80), alt: c.product_name, loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)" } })), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, (c.color || (sku.collection && c.product_name && c.product_name.toLowerCase().startsWith(sku.collection.toLowerCase() + " ") ? c.product_name.substring(sku.collection.length + 1).trim() : c.product_name) || c.product_name)))))), showAttrs && attrSlugs.map((slug) => {
      const allValues = [...attrMap[slug].values].sort(sizeSort);
      const currentVal = currentAttrs[slug];
      const values = allValues.filter((val) => {
        return allSiblings.some((s) => {
          const sa = (s.attributes || []).reduce((m, a) => {
            m[a.slug] = a.value;
            return m;
          }, {});
          if (sa[slug] !== val) return false;
          return attrSlugs.every((otherSlug) => {
            if (otherSlug === slug) return true;
            return !currentAttrs[otherSlug] || sa[otherSlug] === currentAttrs[otherSlug];
          });
        });
      });
      if (values.length <= 1 && !currentVal) return null;
      const findBest = (val) => {
        const matching = allSiblings.filter((s) => {
          if (s.sku_id === sku.sku_id) return false;
          const sa = (s.attributes || []).reduce((m, a) => {
            m[a.slug] = a.value;
            return m;
          }, {});
          return sa[slug] === val;
        });
        if (matching.length === 0) return null;
        if (matching.length === 1) return matching[0];
        const scored = matching.map((s) => {
          const sa = (s.attributes || []).reduce((m, a) => {
            m[a.slug] = a.value;
            return m;
          }, {});
          let score = 0;
          attrSlugs.forEach((k) => {
            if (k !== slug && sa[k] === currentAttrs[k]) score++;
          });
          return { ...s, score };
        });
        return scored.sort((a, b) => b.score - a.score)[0];
      };
      const useImageSwatches = (slug === "countertop_finish" || slug === "finish") && values.length <= 10;
      const getSwatchImage = (val) => {
        if (val === currentVal) {
          if (slug === "countertop_finish" && countertopImage) return countertopImage;
          return media && media[0] ? media[0].url : null;
        }
        const match = findBest(val);
        if (!match) return null;
        if (slug === "countertop_finish") return match.countertop_image || match.primary_image;
        return match.primary_image;
      };
      return /* @__PURE__ */ React.createElement("div", { key: slug, className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, slug === "finish" && attrMap["countertop_finish"] ? "Cabinet Color" : slug === "countertop_finish" ? "Countertop" : attrMap[slug].name, /* @__PURE__ */ React.createElement("span", null, formatCarpetValue(currentVal || ""))), values.length > 10 ? /* @__PURE__ */ React.createElement("select", { className: "attr-select", value: currentVal || "", onChange: (e) => {
        const best = findBest(e.target.value);
        if (best) onSkuClick(best.sku_id);
      } }, values.map((val) => /* @__PURE__ */ React.createElement("option", { key: val, value: val }, formatCarpetValue(val)))) : useImageSwatches ? /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, values.map((val) => {
        const isActive = val === currentVal;
        const img = getSwatchImage(val);
        const best = findBest(val);
        return /* @__PURE__ */ React.createElement("div", { key: val, className: "color-swatch-wrap", onClick: () => {
          if (!isActive && best) onSkuClick(best.sku_id);
        } }, /* @__PURE__ */ React.createElement("div", { className: "color-swatch" + (isActive ? " active" : "") }, img ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(img, 80), alt: formatCarpetValue(val), loading: "lazy", decoding: "async", width: "64", height: "64" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.6rem", color: "var(--stone-500)", textAlign: "center", padding: "0.25rem" } }, formatCarpetValue(val))), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, formatCarpetValue(val)));
      })) : /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, values.map((val) => {
        const isActive = val === currentVal;
        const best = findBest(val);
        return /* @__PURE__ */ React.createElement("button", { key: val, className: "attr-pill" + (isActive ? " active" : ""), onClick: () => {
          if (!isActive && best) onSkuClick(best.sku_id);
        } }, formatCarpetValue(val));
      })));
    }));
  })(), /* @__PURE__ */ React.createElement(StockBadge, { status: sku.stock_status, vendorHasInventory: sku.vendor_has_inventory }), isBackorder && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "0.375rem", padding: "0.75rem 1rem", fontSize: "0.875rem", color: "#92400e", marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("strong", null, "Backorder Available"), " \u2014 This item is currently out of stock. Expected lead time is 2\u20134 weeks. You can still place an order."), sku.stock_status === "out_of_stock" && sku.vendor_has_inventory !== false && /* @__PURE__ */ React.createElement("div", { className: "stock-alert-box" }, alertSuccess || alertSubscribed ? /* @__PURE__ */ React.createElement("div", { className: "stock-alert-success" }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "#166534", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M20 6L9 17l-5-5" })), "We'll notify you when this item is back in stock") : customer ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading }, alertLoading ? "Subscribing..." : "Notify Me When Available")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("div", { className: "stock-alert-form" }, /* @__PURE__ */ React.createElement("input", { type: "email", placeholder: "Enter your email", value: alertEmail, onChange: (e) => setAlertEmail(e.target.value) }), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading || !alertEmail }, alertLoading ? "Subscribing..." : "Notify Me")))), accessorySiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "accessories-section-sf" }, /* @__PURE__ */ React.createElement("h3", null, "Matching Accessories"), /* @__PURE__ */ React.createElement("p", { className: "accessories-subtitle-sf" }, "Complete your installation with coordinating trim and transitions"), accessorySiblings.map((acc) => {
    const accPrice = parseFloat(acc.retail_price) || 0;
    const accQty = accessoryQtys[acc.sku_id] || 1;
    const accSize = (acc.attributes || []).find((a) => a.slug === "size")?.value;
    const accColorLabel = formatVariantName(acc.variant_name) || "";
    const accBaseName = acc.product_name
      ? (accColorLabel ? acc.product_name + " \u2014 " + accColorLabel : acc.product_name)
      : (accColorLabel || "Accessory");
    const accDisplayName = accSize ? accBaseName + " \u2014 " + accSize : accBaseName;
    const accSqftPerBox = parseFloat(acc.sqft_per_box) || 0;
    return /* @__PURE__ */ React.createElement("div", { key: acc.sku_id, className: "accessory-card-sf" }, /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-header" }, /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-name" }, accDisplayName), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-price" }, "$", accPrice.toFixed(2), " /ea", accSqftPerBox > 0 && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.75rem", marginLeft: "0.375rem" } }, "($", (accPrice / accSqftPerBox).toFixed(2), "/sqft)"))), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-actions" }, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: Math.max(1, (prev[acc.sku_id] || 1) - 1) })) }, "\u2212"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", value: accQty, onChange: (e) => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: Math.max(1, parseInt(e.target.value) || 1) })) }), /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: (prev[acc.sku_id] || 1) + 1 })) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { padding: "0.6rem 1.5rem", fontSize: "0.8125rem" }, onClick: () => {
      addToCart({
        product_id: acc.accessory_product_id || sku.product_id,
        sku_id: acc.sku_id,
        sqft_needed: 0,
        num_boxes: accQty,
        include_overage: false,
        unit_price: accPrice,
        subtotal: (accQty * accPrice).toFixed(2),
        sell_by: "unit"
      });
    } }, "Add \u2014 $", (accQty * accPrice).toFixed(2))));
  })), !isCarpetSku && sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "packaging-info" }, /* @__PURE__ */ React.createElement("h4", null, "Packaging Details"), /* @__PURE__ */ React.createElement("div", null, "Coverage: ", sqftPerBox, " sqft/box"), sku.pieces_per_box && /* @__PURE__ */ React.createElement("div", null, "Pieces: ", sku.pieces_per_box, "/box"), sku.weight_per_box_lbs && /* @__PURE__ */ React.createElement("div", null, "Weight: ", parseFloat(sku.weight_per_box_lbs).toFixed(1), " lbs/box"), sku.boxes_per_pallet && /* @__PURE__ */ React.createElement("div", null, "Pallet: ", sku.boxes_per_pallet, " boxes (", parseFloat(sku.sqft_per_pallet || 0).toFixed(0), " sqft)")), isCarpetSku && (rollWidthFt > 0 || rollLengthFt > 0 || sku.sqft_per_pallet || sku.weight_per_pallet_lbs) && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info" }, /* @__PURE__ */ React.createElement("h4", null, "Roll Specifications"), /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-grid" }, rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Width"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, rollWidthFt, " ft")), rollLengthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Length"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, rollLengthFt, " ft")), sku.sqft_per_pallet && parseFloat(sku.sqft_per_pallet) > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Area"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, parseFloat(sku.sqft_per_pallet).toLocaleString(), " sqft")), sku.weight_per_pallet_lbs && parseFloat(sku.weight_per_pallet_lbs) > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-info-row" }, /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-label" }, "Roll Weight"), /* @__PURE__ */ React.createElement("span", { className: "carpet-roll-info-value" }, parseFloat(sku.weight_per_pallet_lbs).toLocaleString(), " lbs")))), isCarpetSku && cutPrice > 0 && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Carpet Calculator"), rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "carpet-roll-width-header" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 20, height: 20 } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "9", x2: "21", y2: "9" })), rollWidthFt, "' Wide Roll"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.375rem", marginBottom: "1rem" } }, rollWidthFt > 0 && /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => setCarpetInputMode("linear"),
      style: { flex: 1, padding: "0.4375rem 0.25rem", border: "1px solid var(--stone-300)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.8125rem", fontWeight: 500, background: carpetInputMode === "linear" ? "var(--stone-900)" : "white", color: carpetInputMode === "linear" ? "white" : "var(--stone-700)", transition: "all 0.15s" }
    },
    "Linear Feet"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => setCarpetInputMode("dimensions"),
      style: { flex: 1, padding: "0.4375rem 0.25rem", border: "1px solid var(--stone-300)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.8125rem", fontWeight: 500, background: carpetInputMode === "dimensions" ? "var(--stone-900)" : "white", color: carpetInputMode === "dimensions" ? "white" : "var(--stone-700)", transition: "all 0.15s" }
    },
    "Room Size"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => setCarpetInputMode("sqft"),
      style: { flex: 1, padding: "0.4375rem 0.25rem", border: "1px solid var(--stone-300)", borderRadius: "0.25rem", cursor: "pointer", fontSize: "0.8125rem", fontWeight: 500, background: carpetInputMode === "sqft" ? "var(--stone-900)" : "white", color: carpetInputMode === "sqft" ? "white" : "var(--stone-700)", transition: "all 0.15s" }
    },
    "Enter Sqft"
  )), carpetInputMode === "linear" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Linear Feet Needed"), /* @__PURE__ */ React.createElement(
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
      className: "btn",
      style: { width: "100%", marginTop: "1.5rem" },
      onClick: handleAddToCart,
      disabled: carpetSqft <= 0
    },
    isBackorder ? "Backorder" : "Add to Cart",
    " ",
    carpetSqft > 0 ? `- $${carpetSubtotal.toFixed(2)}` : ""
  )), !isCarpetSku && hasBoxCalc && effectivePrice > 0 && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Coverage Calculator"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
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
  )), /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Boxes"), /* @__PURE__ */ React.createElement(
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
  ))), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: includeOverage, onChange: (e) => setIncludeOverage(e.target.checked) }), "Add 10% overage for cuts & breakage"), numBoxes > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Boxes Needed"), /* @__PURE__ */ React.createElement("span", null, numBoxes)), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Total Coverage"), /* @__PURE__ */ React.createElement("span", null, actualSqft.toFixed(1), " sqft")), numBoxes > 0 && sku.weight_per_box_lbs && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Est. Weight"), /* @__PURE__ */ React.createElement("span", null, (numBoxes * parseFloat(sku.weight_per_box_lbs)).toFixed(0), " lbs")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", subtotal.toFixed(2)))), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn",
      style: { width: "100%", marginTop: "1.5rem" },
      onClick: handleAddToCart,
      disabled: numBoxes <= 0
    },
    isBackorder ? "Backorder" : "Add to Cart",
    " ",
    numBoxes > 0 ? `- $${subtotal.toFixed(2)}` : ""
  )), !isCarpetSku && isSqftNoBox && effectivePrice > 0 && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Order by Square Footage"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", null, "Square Feet Needed"), /* @__PURE__ */ React.createElement(
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
  ))), parseFloat(sqftInput) > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", sqftOnlySubtotal.toFixed(2)))), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn",
      style: { width: "100%", marginTop: "1.5rem" },
      onClick: handleAddToCart,
      disabled: !(parseFloat(sqftInput) > 0)
    },
    isBackorder ? "Backorder" : "Add to Cart",
    " ",
    parseFloat(sqftInput) > 0 ? `- $${sqftOnlySubtotal.toFixed(2)}` : ""
  )), isPerUnit && /* @__PURE__ */ React.createElement("div", { className: "unit-add-to-cart" }, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-row" }, /* @__PURE__ */ React.createElement("span", { className: "unit-qty-label" }, "Quantity"), /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setUnitQty((q) => Math.max(1, q - 1)) }, "\u2212"), /* @__PURE__ */ React.createElement(
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
      className: "btn",
      style: { width: "100%" },
      onClick: handleAddToCart,
      disabled: unitQty <= 0
    },
    effectivePrice > 0 ? `${isBackorder ? "Backorder" : "Add to Cart"} \u2014 $${unitSubtotal.toFixed(2)}` : isBackorder ? "Backorder" : "Add to Cart"
  )), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn roomvo-visualize-btn",
      ref: (el) => {
        try {
          if (el && window.roomvo) window.roomvo.enableButtonForVisualization(el);
        } catch (e) {
        }
      },
      "data-sku": sku.vendor_sku || sku.internal_sku,
      style: { width: "100%", marginBottom: "1rem", padding: "1.125rem 2rem", fontSize: "0.875rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.625rem", visibility: "hidden" }
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 22, height: 22 } }, /* @__PURE__ */ React.createElement("path", { d: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" }), /* @__PURE__ */ React.createElement("polyline", { points: "9 22 9 12 15 12 15 22" })),
    "Visualize in Your Room"
  ), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", style: { width: "100%", marginBottom: "1rem" }, onClick: handleRequestSample }, "Request Free Sample"), sku && /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn btn-secondary",
      style: { width: "100%", marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" },
      onClick: () => toggleWishlist(sku.product_id)
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: wishlist.includes(sku.product_id) ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 18, height: 18, color: wishlist.includes(sku.product_id) ? "#e11d48" : "currentColor" } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })),
    wishlist.includes(sku.product_id) ? "Saved to Wishlist" : "Add to Wishlist"
  ), /* @__PURE__ */ React.createElement("div", { className: "install-cta" }, /* @__PURE__ */ React.createElement("p", null, "Need professional installation?"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: () => onRequestInstall(sku) }, "Request Installation Quote")))), groupedProducts.length > 0 && (() => {
    const byCategory = {};
    groupedProducts.forEach((gp) => {
      const cat = gp.category_name || "Related";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(gp);
    });
    return /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Complete the Look"), Object.entries(byCategory).map(([catName, items]) => /* @__PURE__ */ React.createElement("div", { key: catName, style: { marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--stone-500)", marginBottom: "0.75rem" } }, catName), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, items.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: s.primary_image ? thumbUrl(s.primary_image, 200) : PLACEHOLDER_SVG, alt: s.product_name, loading: "lazy", decoding: "async", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, s.product_name), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "from $", displayPrice(s, s.retail_price).toFixed(2), priceSuffix(s))))))));
  })(), !isAdexProduct && mainSiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Other Sizes & Finishes"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, mainSiblings.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: s.primary_image ? thumbUrl(s.primary_image, 200) : PLACEHOLDER_SVG, alt: formatVariantName(s.variant_name), loading: "lazy", decoding: "async", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, formatCarpetValue(s.variant_name) || "Variant"), s.attributes && s.attributes.length > 0 && (() => {
    const SKIP = /* @__PURE__ */ new Set(["price_list", "material_class", "style_code", "subcategory", "upc", "color", "color_code", "collection", "material"]);
    const useful = s.attributes.filter((a) => !SKIP.has(a.slug));
    const currentVals = (sku.attributes || []).reduce((m, a) => {
      m[a.slug] = a.value;
      return m;
    }, {});
    const differing = useful.filter((a) => currentVals[a.slug] !== a.value);
    if (differing.length === 0) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta" }, differing.map((a) => formatCarpetValue(a.value)).join(" \xB7 "));
  })(), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(s, s.retail_price).toFixed(2), priceSuffix(s)))))), (() => {
    if (isAdexProduct) return null;
    if (collectionSiblings.length === 0) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "More from ", sku.collection), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, collectionSiblings.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: s.primary_image ? thumbUrl(s.primary_image, 200) : PLACEHOLDER_SVG, alt: s.product_name, loading: "lazy", decoding: "async", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(s)), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(s, s.retail_price).toFixed(2), priceSuffix(s))))));
  })(), recentlyViewed && recentlyViewed.filter((r) => r.sku_id !== skuId).length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.filter((r) => r.sku_id !== skuId).slice(0, 8).map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: s.primary_image ? thumbUrl(s.primary_image, 200) : PLACEHOLDER_SVG, alt: s.product_name, loading: "lazy", decoding: "async", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(s)), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(s, s.retail_price).toFixed(2), priceSuffix(s)))))), /* @__PURE__ */ React.createElement("div", { className: "reviews-section" }, /* @__PURE__ */ React.createElement("h2", null, "Customer Reviews"), reviewCount > 0 && /* @__PURE__ */ React.createElement("div", { className: "reviews-summary" }, /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-rating" }, avgRating.toFixed(1)), /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-stars" }, /* @__PURE__ */ React.createElement(StarDisplay, { rating: avgRating, size: 20 })), /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-count" }, reviewCount, " review", reviewCount !== 1 ? "s" : "")), reviews.length > 0 ? reviews.map((r) => /* @__PURE__ */ React.createElement("div", { key: r.id, className: "review-card" }, /* @__PURE__ */ React.createElement("div", { className: "review-card-header" }, /* @__PURE__ */ React.createElement(StarDisplay, { rating: r.rating, size: 14 }), /* @__PURE__ */ React.createElement("span", { className: "review-card-author" }, r.first_name), /* @__PURE__ */ React.createElement("span", { className: "review-card-date" }, new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))), r.title && /* @__PURE__ */ React.createElement("div", { className: "review-card-title" }, r.title), r.body && /* @__PURE__ */ React.createElement("div", { className: "review-card-body" }, r.body))) : /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.875rem" } }, "No reviews yet. Be the first to share your experience."), customer ? /* @__PURE__ */ React.createElement("div", { className: "review-form" }, /* @__PURE__ */ React.createElement("h3", null, reviewSubmitted ? "Update Your Review" : "Write a Review"), /* @__PURE__ */ React.createElement("div", { className: "star-picker" }, [1, 2, 3, 4, 5].map((i) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: i,
      className: (i <= (reviewHover || reviewRating) ? "active" : "") + (i <= reviewHover ? " hover" : ""),
      onMouseEnter: () => setReviewHover(i),
      onMouseLeave: () => setReviewHover(0),
      onClick: () => setReviewRating(i)
    },
    "\u2605"
  ))), /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Review title (optional)", value: reviewTitle, onChange: (e) => setReviewTitle(e.target.value), maxLength: 200 }), /* @__PURE__ */ React.createElement("textarea", { placeholder: "Share your experience with this product...", value: reviewBody, onChange: (e) => setReviewBody(e.target.value) }), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: handleReviewSubmit, disabled: reviewSubmitting || reviewRating < 1 }, reviewSubmitting ? "Submitting..." : reviewSubmitted ? "Update Review" : "Submit Review")) : /* @__PURE__ */ React.createElement("p", { className: "review-login-prompt" }, /* @__PURE__ */ React.createElement("a", { onClick: onShowAuth }, "Sign in"), " to write a review"))));
}
function CartPage({ cart, goBrowse, removeFromCart, updateCartItem, goCheckout, deliveryMethod, setDeliveryMethod, sessionId, appliedPromoCode, setAppliedPromoCode, goHome }) {
  const [shippingZip, setShippingZip] = useState("");
  const [shippingEstimate, setShippingEstimate] = useState(null);
  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingError, setShippingError] = useState("");
  const [selectedShippingOption, setSelectedShippingOption] = useState(null);
  const [liftgateEnabled, setLiftgateEnabled] = useState(true);
  const [promoCode, setPromoCode] = useState(appliedPromoCode || "");
  const [promoResult, setPromoResult] = useState(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState("");
  const promoSubtotalRef = useRef(null);
  const productItems = cart.filter((i) => !i.is_sample);
  const sampleItems = cart.filter((i) => i.is_sample);
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
    }).then((r) => r.json()).then((data) => {
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
    }).then((r) => r.json()).then((data) => {
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
      const sqftPerBox = item.sqft_needed && item.num_boxes ? parseFloat(item.sqft_needed) / parseInt(item.num_boxes) : 17.11;
      const newSqft = (newBoxes * sqftPerBox).toFixed(2);
      const newSubtotal = (newBoxes * sqftPerBox * unitPrice).toFixed(2);
      updateCartItem(item.id, { num_boxes: newBoxes, sqft_needed: newSqft, subtotal: newSubtotal });
    }
    setShippingEstimate(null);
    setSelectedShippingOption(null);
  };
  return /* @__PURE__ */ React.createElement("div", { className: "cart-page" }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: [
    { label: "Home", onClick: goHome },
    { label: "Cart" }
  ] }), /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goBrowse }, "\u2190 Continue Shopping"), /* @__PURE__ */ React.createElement("h1", null, "Your Cart"), cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length > 0 && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "0.375rem", padding: "0.75rem 1rem", fontSize: "0.875rem", color: "#92400e", marginBottom: "1rem", borderLeft: "3px solid #f59e0b" } }, cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length, " item", cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length !== 1 ? "s are" : " is", " currently out of stock and may take 2\u20134 weeks (backorder)."), cart.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem 0", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "1.125rem", marginBottom: "2rem" } }, "Your cart is empty"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Browse Products")) : /* @__PURE__ */ React.createElement("div", { className: "cart-page-layout" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cart-table" }, /* @__PURE__ */ React.createElement("div", { className: "cart-table-header" }, /* @__PURE__ */ React.createElement("div", null, "Product"), /* @__PURE__ */ React.createElement("div", null, "Quantity"), /* @__PURE__ */ React.createElement("div", null, "Coverage"), /* @__PURE__ */ React.createElement("div", null, "Total"), /* @__PURE__ */ React.createElement("div", null)), cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "cart-table-row" + (item.is_sample ? " sample-item" : "") }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cart-table-product-name" }, fullProductName(item) || "Product", item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "sample-tag" }, "Sample"), !item.is_sample && item.vendor_has_inventory !== false && item.stock_status === "out_of_stock" && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: "#fef3c7", color: "#92400e" } }, "Backorder"), !item.is_sample && item.vendor_has_inventory !== false && item.stock_status === "low_stock" && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: "#fff7ed", color: "#c2410c" } }, "Low Stock")), /* @__PURE__ */ React.createElement("div", { className: "cart-table-product-meta" }, item.is_sample ? "Free sample" : /* @__PURE__ */ React.createElement(React.Fragment, null, "$", parseFloat(item.unit_price).toFixed(2), item.sell_by === "unit" ? "/ea" : item.sell_by === "sqyd" ? "/sqyd" : "/sqft", item.price_tier && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: item.price_tier === "roll" ? "var(--sage, #6b9080)" : "var(--stone-200)", color: item.price_tier === "roll" ? "white" : "var(--stone-600)" } }, item.price_tier === "roll" ? "Roll Price" : "Cut Price")))), /* @__PURE__ */ React.createElement("div", null, item.is_sample ? "1" : item.price_tier ? /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, fontSize: "0.875rem" } }, parseFloat(item.sqft_needed || 0).toFixed(0), " sqft") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-qty-controls" }, /* @__PURE__ */ React.createElement("button", { className: "cart-qty-btn", onClick: () => handleQtyChange(item, -1) }, "\u2212"), /* @__PURE__ */ React.createElement("span", { style: { width: 40, textAlign: "center", fontWeight: 500 } }, item.num_boxes), /* @__PURE__ */ React.createElement("button", { className: "cart-qty-btn", onClick: () => handleQtyChange(item, 1) }, "+")), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-600)", marginTop: "0.25rem" } }, item.sell_by === "unit" ? parseInt(item.num_boxes) !== 1 ? "units" : "unit" : "box" + (parseInt(item.num_boxes) !== 1 ? "es" : "")))), /* @__PURE__ */ React.createElement("div", null, item.is_sample || item.sell_by === "unit" ? "\u2014" : parseFloat(item.sqft_needed || 0).toFixed(1) + " sqft"), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { className: "cart-remove-btn", onClick: () => removeFromCart(item.id), title: "Remove" }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))))))), /* @__PURE__ */ React.createElement("div", { className: "order-summary" }, /* @__PURE__ */ React.createElement("h3", null, "Order Summary"), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Products (", [totalBoxes > 0 && `${totalBoxes} box${totalBoxes !== 1 ? "es" : ""}`, totalUnits > 0 && `${totalUnits} unit${totalUnits !== 1 ? "s" : ""}`].filter(Boolean).join(", "), ")"), /* @__PURE__ */ React.createElement("span", null, "$", productSubtotal.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Samples (", sampleItems.length, ")"), /* @__PURE__ */ React.createElement("span", null, "FREE")), /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Sample Shipping"), /* @__PURE__ */ React.createElement("span", null, "$12.00"))), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Delivery Method"), hasPickupOnly && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "#b45309", background: "#fef3c7", padding: "0.5rem 0.75rem", marginBottom: "0.5rem", borderLeft: "3px solid #f59e0b" } }, "Your cart contains items available for store pickup only."), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem", cursor: hasPickupOnly ? "not-allowed" : "pointer", marginBottom: "0.4rem", opacity: hasPickupOnly ? 0.5 : 1 } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "radio",
      name: "deliveryMethod",
      value: "shipping",
      checked: deliveryMethod === "shipping",
      onChange: () => setDeliveryMethod("shipping"),
      disabled: hasPickupOnly
    }
  ), "Ship to Address ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-600)", fontSize: "0.75rem" } }, "(5-10 business days)")), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem", cursor: "pointer", marginBottom: "0.5rem" } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "radio",
      name: "deliveryMethod",
      value: "pickup",
      checked: deliveryMethod === "pickup",
      onChange: () => {
        setDeliveryMethod("pickup");
        setShippingEstimate(null);
        setSelectedShippingOption(null);
      }
    }
  ), "Store Pickup \u2014 Free ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-600)", fontSize: "0.75rem" } }, "(up to 5 business days)")), deliveryMethod === "pickup" && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row", style: { marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("span", null, "Shipping"), /* @__PURE__ */ React.createElement("span", { style: { color: "#16a34a", fontWeight: 500 } }, "FREE")), deliveryMethod === "shipping" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem", marginTop: "0.5rem" } }, "Estimate Shipping"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.5rem" } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "checkout-input",
      style: { flex: 1, padding: "0.6rem 0.75rem", fontSize: "0.875rem" },
      type: "text",
      placeholder: "ZIP Code",
      value: shippingZip,
      onChange: (e) => setShippingZip(e.target.value.replace(/\D/g, "").slice(0, 5)),
      onKeyDown: (e) => e.key === "Enter" && fetchShippingEstimate(),
      maxLength: 5
    }
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn",
      style: { padding: "0.6rem 1rem", fontSize: "0.75rem" },
      onClick: fetchShippingEstimate,
      disabled: shippingLoading || shippingZip.length < 5
    },
    shippingLoading ? "..." : "Get Rate"
  )), shippingError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "#dc2626", marginTop: "0.4rem" } }, shippingError), shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", fontWeight: 500, marginBottom: "0.4rem", color: "var(--stone-700)" } }, shippingEstimate.method === "ltl_freight" ? "LTL Freight Options" : "Shipping"), shippingEstimate.options.map((opt) => /* @__PURE__ */ React.createElement(
    "label",
    {
      key: opt.id,
      onClick: () => setSelectedShippingOption(opt),
      style: {
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.6rem 0.75rem",
        marginBottom: "0.35rem",
        cursor: "pointer",
        fontSize: "0.8125rem",
        border: selectedShippingOption && selectedShippingOption.id === opt.id ? "2px solid var(--gold)" : "1px solid var(--stone-200)",
        borderRadius: "6px",
        background: selectedShippingOption && selectedShippingOption.id === opt.id ? "#fefce8" : "white",
        transition: "border-color 0.15s"
      }
    },
    /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "radio",
        name: "shippingOption",
        checked: selectedShippingOption && selectedShippingOption.id === opt.id,
        onChange: () => setSelectedShippingOption(opt)
      }
    ),
    /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "0.4rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, opt.carrier), opt.service && opt.service !== opt.carrier && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-600)", fontSize: "0.75rem" } }, opt.service), opt.is_cheapest && /* @__PURE__ */ React.createElement("span", { style: { background: "#dcfce7", color: "#166534", fontSize: "0.625rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px" } }, "Best Price")), opt.transit_days && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", color: "var(--stone-600)", marginTop: "0.15rem" } }, "Est. ", opt.transit_days, " business day", opt.transit_days !== 1 ? "s" : "")),
    /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 600, whiteSpace: "nowrap" } }, "$", parseFloat(opt.amount).toFixed(2))
  )), shippingEstimate.options.some((o) => o.is_fallback) && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", color: "#b45309", background: "#fef3c7", padding: "0.4rem 0.6rem", marginTop: "0.25rem", borderRadius: "4px" } }, "Estimated rate. Final rate calculated at confirmation.")), shippingEstimate && shippingEstimate.options && shippingEstimate.options.length > 0 && shippingEstimate.options[0].amount === 0 && shippingEstimate.method === null && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted", style: { marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("span", null, "Shipping"), /* @__PURE__ */ React.createElement("span", null, "$0.00")), !shippingEstimate && !shippingLoading && !shippingError && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-600)", marginTop: "0.4rem" } }, "Enter zip for shipping estimate"), shippingEstimate && shippingEstimate.weight_lbs > 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", color: "var(--stone-600)", marginTop: "0.25rem" } }, "Est. weight: ", shippingEstimate.weight_lbs, " lbs (", shippingEstimate.total_boxes, " item", shippingEstimate.total_boxes !== 1 ? "s" : "", ")"), shippingEstimate && shippingEstimate.method === "ltl_freight" && /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.75rem", color: "var(--stone-600)", marginTop: "0.4rem", cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: liftgateEnabled, onChange: (e) => {
    setLiftgateEnabled(e.target.checked);
    setShippingEstimate(null);
    setSelectedShippingOption(null);
  } }), "Liftgate delivery (residential)"))), /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--stone-200)", marginTop: "0.75rem", paddingTop: "0.75rem" } }, promoResult ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "order-summary-row", style: { color: "#16a34a" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "0.4rem" } }, /* @__PURE__ */ React.createElement("span", { style: { background: "#dcfce7", color: "#166534", padding: "0.15rem 0.5rem", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 } }, promoResult.code), /* @__PURE__ */ React.createElement("a", { onClick: removePromo, style: { fontSize: "0.75rem", color: "var(--stone-500)", cursor: "pointer", textDecoration: "underline" } }, "Remove")), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, "-$", promoDiscount.toFixed(2))), promoResult.description && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", color: "var(--stone-500)", marginTop: "0.15rem" } }, promoResult.description)) : /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.5rem" } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "text",
      value: promoCode,
      onChange: (e) => {
        setPromoCode(e.target.value.toUpperCase());
        setPromoError("");
      },
      placeholder: "Promo code",
      onKeyDown: (e) => e.key === "Enter" && applyPromoCode(),
      style: { flex: 1, padding: "0.5rem 0.6rem", border: "1px solid var(--stone-300)", borderRadius: "4px", fontSize: "0.8rem", fontFamily: "'Inter', sans-serif" }
    }
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      onClick: () => applyPromoCode(),
      disabled: promoLoading || !promoCode.trim(),
      style: { padding: "0.5rem 0.75rem", background: "var(--stone-800)", color: "white", border: "none", borderRadius: "4px", fontSize: "0.8rem", cursor: "pointer", opacity: promoLoading || !promoCode.trim() ? 0.5 : 1 }
    },
    promoLoading ? "..." : "Apply"
  )), promoError && /* @__PURE__ */ React.createElement("div", { style: { color: "#dc2626", fontSize: "0.75rem", marginTop: "0.3rem" } }, promoError))), /* @__PURE__ */ React.createElement("div", { className: "order-summary-total" }, /* @__PURE__ */ React.createElement("span", null, selectedShippingOption ? "Estimated Total" : "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), cartTotal >= 35 && /* @__PURE__ */ React.createElement(KlarnaMessage, { amountCents: Math.round(cartTotal * 100) }), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%", marginTop: "1rem" }, onClick: goCheckout }, "Proceed to Checkout"))));
}
function KlarnaMessage({ amountCents }) {
  const containerRef = useRef(null);
  const elementRef = useRef(null);
  useEffect(() => {
    if (!stripeInstance || !containerRef.current || amountCents < 3500) return;
    try {
      if (!elementRef.current) {
        const elements = stripeInstance.elements();
        elementRef.current = elements.create("paymentMethodMessaging", {
          amount: amountCents,
          currency: "USD",
          paymentMethodTypes: ["klarna"],
          countryCode: "US"
        });
        elementRef.current.mount(containerRef.current);
      } else {
        elementRef.current.update({ amount: amountCents });
      }
    } catch (err) {
      console.warn("[Klarna] paymentMethodMessaging not available:", err.message);
    }
    return () => {
      try {
        if (elementRef.current) {
          elementRef.current.unmount();
          elementRef.current = null;
        }
      } catch {
      }
    };
  }, [amountCents]);
  if (amountCents < 3500) return null;
  return React.createElement("div", { ref: containerRef, className: "klarna-messaging" });
}
function CheckoutPage({ cart, sessionId, goCart, handleOrderComplete, deliveryMethod, tradeCustomer, tradeToken, customer, customerToken, onCustomerLogin, appliedPromoCode, setAppliedPromoCode, klarnaReturn }) {
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
  const [paymentMethodType, setPaymentMethodType] = useState("card");
  const [klarnaProcessing, setKlarnaProcessing] = useState(false);
  const [taxEstimate, setTaxEstimate] = useState({ rate: 0, amount: 0 });
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
  const isPickup = deliveryMethod === "pickup";
  const productItems = cart.filter((i) => !i.is_sample);
  const sampleItems = cart.filter((i) => i.is_sample);
  const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
  const sampleShipping = sampleItems.length > 0 ? 12 : 0;
  const cartTotal = productSubtotal + sampleShipping + taxEstimate.amount;
  const US_STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
  const [stripeLoaded, setStripeLoaded] = useState(!!stripeInstance);
  useEffect(() => {
    if (!stripeInstance) {
      stripePromise.then(() => setStripeLoaded(true));
    }
  }, []);
  useEffect(() => {
    if (paymentMethodType !== "card") {
      if (cardRef.current && cardMounted.current) {
        cardRef.current.unmount();
        cardMounted.current = false;
      }
      return;
    }
    if (cardMounted.current) return;
    const el = document.getElementById("card-element");
    if (!el || !stripeInstance) return;
    const elements = stripeInstance.elements();
    const card = elements.create("card", {
      style: { base: { fontFamily: "'Inter', sans-serif", fontSize: "15px", color: "#292524", "::placeholder": { color: "#57534e" } } }
    });
    card.mount("#card-element");
    cardRef.current = card;
    cardMounted.current = true;
    return () => {
      if (cardRef.current) {
        cardRef.current.unmount();
        cardMounted.current = false;
      }
    };
  }, [paymentMethodType, stripeLoaded]);
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const [walletMode, setWalletMode] = useState(null);
  useEffect(() => {
    if (!stripeInstance) return;
    const pr = stripeInstance.paymentRequest({
      country: "US",
      currency: "usd",
      total: { label: "Roma Flooring Designs", amount: Math.round(cartTotal * 100) || 100 },
      requestPayerName: true,
      requestPayerEmail: true,
      requestPayerPhone: true
    });
    pr.canMakePayment().then((result) => {
      if (result) {
        setWalletAvailable(true);
        setWalletMode("native");
        paymentRequestRef.current = pr;
      } else if (isLocalDev) {
        setWalletAvailable(true);
        setWalletMode("simulated");
      }
    });
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
        const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
        if (!isPickup) {
          piBody.destination = { zip, city, state };
          piBody.residential = true;
          piBody.liftgate = true;
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
          liftgate: true
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
    setError("");
    setProcessing(true);
    try {
      const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
      if (!isPickup) {
        piBody.destination = { zip, city, state };
        piBody.residential = true;
        piBody.liftgate = true;
      }
      const piRes = await fetch(API + "/api/checkout/create-payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(piBody)
      });
      const piData = await piRes.json();
      if (piData.error) {
        setError(piData.error);
        setProcessing(false);
        return;
      }
      const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
        piData.clientSecret,
        { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
      );
      if (stripeError) {
        setError(stripeError.message);
        setProcessing(false);
        return;
      }
      const orderBody = {
        session_id: sessionId,
        payment_intent_id: paymentIntent.id,
        customer_name: customerName,
        customer_email: customerEmail,
        phone,
        delivery_method: deliveryMethod,
        shipping: isPickup ? null : { line1, line2, city, state, zip },
        residential: true,
        liftgate: true,
        create_account: createAccount || void 0,
        account_password: createAccount ? accountPassword : void 0
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
      handleOrderComplete(orderData.order);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setProcessing(false);
    }
  };
  useEffect(() => {
    if (isPickup) return;
    let cancelled = false;
    fetch(API + "/api/config/google-places-key").then((r) => r.json()).then((data) => {
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
    const taxZip = isPickup ? "92806" : zip;
    if (!taxZip || taxZip.length < 5) {
      setTaxEstimate({ rate: 0, amount: 0 });
      return;
    }
    clearTimeout(taxDebounce.current);
    taxDebounce.current = setTimeout(async () => {
      try {
        const resp = await fetch(API + "/api/cart/tax-estimate?zip=" + encodeURIComponent(taxZip) + "&session_id=" + encodeURIComponent(sessionId));
        const data = await resp.json();
        setTaxEstimate({ rate: data.rate || 0, amount: data.amount || 0 });
      } catch {
        setTaxEstimate({ rate: 0, amount: 0 });
      }
    }, 400);
    return () => clearTimeout(taxDebounce.current);
  }, [zip, isPickup, sessionId]);
  useEffect(() => {
    if (!klarnaReturn) return;
    const { paymentIntentId, redirectStatus } = klarnaReturn;
    if (redirectStatus !== "succeeded") {
      setError(redirectStatus === "failed" ? "Klarna payment was declined. Please try another payment method." : "Klarna payment was cancelled.");
      return;
    }
    const saved = localStorage.getItem("klarna_checkout_data");
    if (!saved) {
      setError("Could not restore checkout data after Klarna redirect. Please try again.");
      return;
    }
    const data = JSON.parse(saved);
    localStorage.removeItem("klarna_checkout_data");
    setKlarnaProcessing(true);
    setProcessing(true);
    const orderBody = {
      session_id: sessionId,
      payment_intent_id: paymentIntentId,
      customer_name: data.customerName,
      customer_email: data.customerEmail,
      phone: data.phone,
      delivery_method: deliveryMethod,
      shipping: data.isPickup ? null : { line1: data.line1, line2: data.line2, city: data.city, state: data.state, zip: data.zip },
      residential: true,
      liftgate: true,
      create_account: data.createAccount || void 0,
      account_password: data.createAccount ? data.accountPassword : void 0,
      promo_code: data.promoCode || void 0,
      payment_method: "klarna"
    };
    const orderHeaders = { "Content-Type": "application/json" };
    if (tradeToken) orderHeaders["X-Trade-Token"] = tradeToken;
    if (customerToken) orderHeaders["X-Customer-Token"] = customerToken;
    fetch(API + "/api/checkout/place-order", { method: "POST", headers: orderHeaders, body: JSON.stringify(orderBody) }).then((r) => r.json()).then((orderData) => {
      if (orderData.error) {
        setError(orderData.error);
        setProcessing(false);
        setKlarnaProcessing(false);
        return;
      }
      if (orderData.customer_token && orderData.customer && onCustomerLogin) {
        onCustomerLogin(orderData.customer_token, orderData.customer);
      }
      handleOrderComplete(orderData.order);
    }).catch((err) => {
      setError(err.message || "Failed to place order after Klarna approval.");
      setProcessing(false);
      setKlarnaProcessing(false);
    });
  }, [klarnaReturn]);
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
    setProcessing(true);
    try {
      if (paymentMethodType === "bank_transfer") {
        if (productSubtotal < 500) {
          setError("Bank transfer requires a minimum product subtotal of $500.");
          setProcessing(false);
          return;
        }
        const btBody = { session_id: sessionId, delivery_method: deliveryMethod, customer_email: customerEmail };
        if (!isPickup) {
          btBody.destination = { zip, city, state };
          btBody.residential = true;
          btBody.liftgate = true;
        }
        if (appliedPromoCode) btBody.promo_code = appliedPromoCode;
        const btRes = await fetch(API + "/api/checkout/create-bank-transfer-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(btBody)
        });
        const btData = await btRes.json();
        if (btData.error) {
          setError(btData.error);
          setProcessing(false);
          return;
        }
        const orderBody2 = {
          session_id: sessionId,
          payment_intent_id: btData.paymentIntentId,
          customer_name: customerName,
          customer_email: customerEmail,
          phone,
          delivery_method: deliveryMethod,
          shipping: isPickup ? null : { line1, line2, city, state, zip },
          residential: true,
          liftgate: true,
          create_account: createAccount || void 0,
          account_password: createAccount ? accountPassword : void 0,
          promo_code: appliedPromoCode || void 0,
          payment_method: "bank_transfer",
          bank_instructions: btData.bankInstructions
        };
        const orderHeaders2 = { "Content-Type": "application/json" };
        if (tradeToken) orderHeaders2["X-Trade-Token"] = tradeToken;
        if (customerToken) orderHeaders2["X-Customer-Token"] = customerToken;
        const orderRes2 = await fetch(API + "/api/checkout/place-order", {
          method: "POST",
          headers: orderHeaders2,
          body: JSON.stringify(orderBody2)
        });
        const orderData2 = await orderRes2.json();
        if (orderData2.error) {
          setError(orderData2.error);
          setProcessing(false);
          return;
        }
        if (orderData2.customer_token && orderData2.customer && onCustomerLogin) {
          onCustomerLogin(orderData2.customer_token, orderData2.customer);
        }
        handleOrderComplete({ order: orderData2.order, sample_request: orderData2.sample_request || null, bank_instructions: orderData2.bank_instructions || btData.bankInstructions });
        return;
      }
      if (!stripeInstance) {
        await stripePromise;
        if (!stripeInstance) {
          setError("Payment system could not be loaded. Please refresh and try again.");
          setProcessing(false);
          return;
        }
      }
      const piBody = { session_id: sessionId, delivery_method: deliveryMethod };
      if (!isPickup) {
        piBody.destination = { zip, city, state };
        piBody.residential = true;
        piBody.liftgate = true;
      }
      const piRes = await fetch(API + "/api/checkout/create-payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(piBody)
      });
      const piData = await piRes.json();
      if (piData.error) {
        setError(piData.error);
        setProcessing(false);
        return;
      }
      if (paymentMethodType === "klarna") {
        const totalCents = Math.round(cartTotal * 100);
        if (totalCents < 3500) {
          setError("Klarna requires a minimum order of $35.");
          setProcessing(false);
          return;
        }
        localStorage.setItem("klarna_checkout_data", JSON.stringify({
          customerName,
          customerEmail,
          phone,
          line1,
          line2,
          city,
          state,
          zip,
          isPickup,
          createAccount,
          accountPassword,
          promoCode: appliedPromoCode || void 0
        }));
        await fetch(API + "/api/checkout/update-payment-intent-shipping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payment_intent_id: piData.paymentIntentId,
            shipping: {
              name: customerName,
              address: isPickup ? { line1: "1440 S. State College Blvd., Suite 6M", city: "Anaheim", state: "CA", postal_code: "92806" } : { line1, line2, city, state, postal_code: zip }
            }
          })
        });
        const { error: klarnaError } = await stripeInstance.confirmKlarnaPayment(
          piData.clientSecret,
          {
            payment_method: { billing_details: { name: customerName, email: customerEmail, phone, address: { line1: isPickup ? "" : line1, line2: isPickup ? "" : line2, city: isPickup ? "" : city, state: isPickup ? "" : state, postal_code: isPickup ? "" : zip, country: "US" } } },
            return_url: window.location.origin + "/checkout"
          }
        );
        if (klarnaError) {
          setError(klarnaError.message);
        }
        setProcessing(false);
        return;
      }
      const { error: stripeError, paymentIntent } = await stripeInstance.confirmCardPayment(
        piData.clientSecret,
        { payment_method: { card: cardRef.current, billing_details: { name: customerName, email: customerEmail } } }
      );
      if (stripeError) {
        setError(stripeError.message);
        setProcessing(false);
        return;
      }
      const orderBody = {
        session_id: sessionId,
        payment_intent_id: paymentIntent.id,
        customer_name: customerName,
        customer_email: customerEmail,
        phone,
        delivery_method: deliveryMethod,
        shipping: isPickup ? null : { line1, line2, city, state, zip },
        residential: true,
        liftgate: true,
        create_account: createAccount || void 0,
        account_password: createAccount ? accountPassword : void 0
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
      handleOrderComplete(orderData.order);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setProcessing(false);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "checkout-page" }, /* @__PURE__ */ React.createElement("h1", null, "Checkout"), klarnaProcessing && /* @__PURE__ */ React.createElement("div", { style: { background: "#fdf2f8", border: "1px solid #f9a8d4", borderRadius: "0.375rem", padding: "1rem", fontSize: "0.875rem", color: "#9d174d", marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("span", { className: "checkout-spinner", style: { borderColor: "rgba(157,23,77,0.3)", borderTopColor: "#9d174d" } }), "Completing your Klarna order..."), cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length > 0 && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "0.375rem", padding: "0.75rem 1rem", fontSize: "0.875rem", color: "#92400e", marginBottom: "1rem", borderLeft: "3px solid #f59e0b" } }, cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length, " item", cart.filter((i) => !i.is_sample && i.stock_status === "out_of_stock" && i.vendor_has_inventory !== false).length !== 1 ? "s are" : " is", " out of stock and may take 2\u20134 weeks."), /* @__PURE__ */ React.createElement("form", { className: "checkout-form", onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Contact Information"), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Full Name *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: customerName, onChange: (e) => setCustomerName(e.target.value), placeholder: "John Smith" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: customerEmail, onChange: (e) => setCustomerEmail(e.target.value), placeholder: "john@example.com" }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "tel", value: phone, onChange: (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
    let fmt = "";
    if (digits.length > 0) fmt = "(" + digits.slice(0, 3);
    if (digits.length >= 3) fmt += ") ";
    if (digits.length > 3) fmt += digits.slice(3, 6);
    if (digits.length >= 6) fmt += "-" + digits.slice(6);
    setPhone(fmt);
  }, placeholder: "(555) 123-4567" }))), !customer && !tradeCustomer && /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.9375rem" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: createAccount, onChange: (e) => {
    setCreateAccount(e.target.checked);
    if (!e.target.checked) {
      setAccountPassword("");
      setConfirmPassword("");
      setPasswordError("");
    }
  } }), "Create an account for faster checkout next time"), createAccount && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Password *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: accountPassword, onChange: (e) => {
    setAccountPassword(e.target.value);
    setPasswordError("");
  }, placeholder: "Create a password", autoComplete: "new-password" }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginTop: "0.25rem" } }, "Min 8 characters, 1 uppercase letter, 1 number")), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Confirm Password *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: confirmPassword, onChange: (e) => {
    setConfirmPassword(e.target.value);
    setPasswordError("");
  }, placeholder: "Re-enter password", autoComplete: "new-password" })), passwordError && /* @__PURE__ */ React.createElement("div", { style: { color: "#dc2626", fontSize: "0.8125rem" } }, passwordError))), isPickup ? /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Store Pickup"), /* @__PURE__ */ React.createElement("div", { style: { background: "var(--stone-100)", padding: "1.25rem", fontSize: "0.875rem", lineHeight: 1.6 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, marginBottom: "0.5rem" } }, "Pickup Location"), /* @__PURE__ */ React.createElement("div", null, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("div", null, "1440 S. State College Blvd., Suite 6M"), /* @__PURE__ */ React.createElement("div", null, "Anaheim, CA 92806"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.75rem", color: "var(--stone-600)", fontSize: "0.8125rem" } }, "Ready for pickup within 5 business days."))) : /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Shipping Address"), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Address Line 1 *"), /* @__PURE__ */ React.createElement("input", { ref: addressInputRef, className: "checkout-input", value: line1, onChange: (e) => setLine1(e.target.value), placeholder: "Start typing an address...", autoComplete: "off" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Address Line 2"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: line2, onChange: (e) => setLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-row-3" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "City *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: city, onChange: (e) => setCity(e.target.value), placeholder: "New York" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "State *"), /* @__PURE__ */ React.createElement("select", { className: "checkout-input", value: state, onChange: (e) => setState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "ZIP *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: zip, onChange: (e) => setZip(e.target.value), placeholder: "10001" })))), /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Payment"), walletAvailable && /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Express Checkout"), walletMode === "native" ? /* @__PURE__ */ React.createElement("div", { id: "payment-request-button" }) : /* @__PURE__ */ React.createElement("button", { type: "button", className: "simulated-wallet-btn", onClick: handleSimulatedWalletPay, disabled: processing }, /* @__PURE__ */ React.createElement("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "4", width: "22", height: "16", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "10", x2: "23", y2: "10" })), processing ? "Processing..." : "Pay with Wallet", isLocalDev && /* @__PURE__ */ React.createElement("span", { className: "dev-badge" }, "DEV")), /* @__PURE__ */ React.createElement("div", { className: "checkout-divider" }, "or pay below")), /* @__PURE__ */ React.createElement("div", { className: "payment-method-tabs" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "payment-method-tab" + (paymentMethodType === "card" ? " active" : ""), onClick: () => setPaymentMethodType("card") }, /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "1", y: "4", width: "22", height: "16", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "1", y1: "10", x2: "23", y2: "10" })), "Credit Card"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "payment-method-tab" + (paymentMethodType === "klarna" ? " active" : ""), onClick: () => setPaymentMethodType("klarna") }, /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("path", { d: "M8 8h4a2 2 0 010 4H8V8zM8 12h5a2 2 0 010 4H8v-4z" })), "Pay with Klarna"), productSubtotal >= 500 && /* @__PURE__ */ React.createElement("button", { type: "button", className: "payment-method-tab" + (paymentMethodType === "bank_transfer" ? " active" : ""), onClick: () => setPaymentMethodType("bank_transfer") }, /* @__PURE__ */ React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3" })), "Bank Transfer")), paymentMethodType === "card" && /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Card Details"), /* @__PURE__ */ React.createElement("div", { id: "card-element", className: "stripe-element" })), paymentMethodType === "klarna" && /* @__PURE__ */ React.createElement("div", { className: "klarna-info-box" }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: "0.5rem", fontSize: "0.9375rem" } }, "Pay over time with Klarna"), /* @__PURE__ */ React.createElement("ul", { style: { margin: "0 0 0.75rem 1.25rem", padding: 0, fontSize: "0.8125rem", lineHeight: 1.7, color: "var(--stone-700)" } }, /* @__PURE__ */ React.createElement("li", null, "Pay in 4 interest-free installments"), /* @__PURE__ */ React.createElement("li", null, "Or choose monthly financing for 6\u201336 months"), /* @__PURE__ */ React.createElement("li", null, "No hidden fees \u2014 soft credit check only"), /* @__PURE__ */ React.createElement("li", null, "Instant decision at checkout")), cartTotal >= 35 && /* @__PURE__ */ React.createElement(KlarnaMessage, { amountCents: Math.round(cartTotal * 100) }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginTop: "0.5rem", padding: "0.5rem", background: "var(--stone-50)", borderRadius: "4px" } }, "You'll be redirected to Klarna to choose your payment plan. After approval, you'll return here automatically to confirm your order.")), paymentMethodType === "bank_transfer" && /* @__PURE__ */ React.createElement("div", { className: "bank-transfer-info-box" }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: "0.5rem", fontSize: "0.9375rem" } }, "Pay via Bank Transfer"), /* @__PURE__ */ React.createElement("ul", { style: { margin: "0 0 0.75rem 1.25rem", padding: 0, fontSize: "0.8125rem", lineHeight: 1.7, color: "var(--stone-700)" } }, /* @__PURE__ */ React.createElement("li", null, "Lower fees on large orders \u2014 no credit card surcharge"), /* @__PURE__ */ React.createElement("li", null, "Send payment from your bank using the details we provide"), /* @__PURE__ */ React.createElement("li", null, "Order confirmed once payment is received (1\u20133 business days)"), /* @__PURE__ */ React.createElement("li", null, "No chargeback risk \u2014 ideal for orders $500+")), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginTop: "0.5rem", padding: "0.5rem", background: "var(--stone-50)", borderRadius: "4px" } }, "After placing your order, you'll receive bank account details to send your payment. Your order will be held for 14 days while we await your transfer."))), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "checkout-btn", disabled: processing || klarnaProcessing }, processing && /* @__PURE__ */ React.createElement("span", { className: "checkout-spinner" }), processing ? paymentMethodType === "klarna" ? "Redirecting to Klarna..." : paymentMethodType === "bank_transfer" ? "Creating Bank Transfer..." : "Processing..." : paymentMethodType === "klarna" ? `Continue to Klarna \u2014 $${cartTotal.toFixed(2)}` : paymentMethodType === "bank_transfer" ? `Place Order via Bank Transfer \u2014 $${cartTotal.toFixed(2)}` : isPickup ? `Place Order - $${cartTotal.toFixed(2)}` : "Place Order")), /* @__PURE__ */ React.createElement("div", { className: "order-summary" }, /* @__PURE__ */ React.createElement("h3", null, "Order Summary"), cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { fontSize: "0.875rem", marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--stone-100)" } }, /* @__PURE__ */ React.createElement("div", { className: "order-summary-row" }, /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, item.collection || item.product_name || "Product", !item.is_sample && item.stock_status === "out_of_stock" && item.vendor_has_inventory !== false && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.3rem", borderRadius: "0.1875rem", fontSize: "0.625rem", fontWeight: 600, background: "#fef3c7", color: "#92400e" } }, "Backorder")), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginTop: "0.125rem" } }, item.variant_name && /* @__PURE__ */ React.createElement("span", null, item.variant_name), item.variant_name && item.variant_type === "accessory" && /* @__PURE__ */ React.createElement("span", null, " (Accessory)"), item.is_sample ? " \u2014 Sample" : item.sell_by === "unit" ? ` \u2014 Qty ${item.num_boxes}` : ` \u2014 ${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? "es" : ""}`))), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row", style: { borderTop: "1px solid var(--stone-200)", marginTop: "0.5rem", paddingTop: "0.75rem" } }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", productSubtotal.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Sample Shipping"), /* @__PURE__ */ React.createElement("span", null, "$12.00")), taxEstimate.amount > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Estimated Tax (", (taxEstimate.rate * 100).toFixed(2), "%)"), /* @__PURE__ */ React.createElement("span", null, "$", taxEstimate.amount.toFixed(2))), /* @__PURE__ */ React.createElement("div", { className: "order-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Total"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goCart, style: { marginTop: "1rem", display: "inline-block" } }, "\u2190 Back to Cart")));
}
function ConfirmationPage({ orderData, goBrowse }) {
  if (!orderData) return null;
  const order = orderData.order;
  const sampleRequest = orderData.sample_request;
  const bankInstructions = orderData.bank_instructions;
  const items = order ? order.items || [] : [];
  const sampleItems = sampleRequest ? sampleRequest.items || [] : [];
  const isBankTransfer = !!(bankInstructions || order && order.payment_method === "bank_transfer");
  const bi = bankInstructions || {};
  const fa = (bi.financial_addresses || [])[0] || {};
  const aba = fa.aba || {};
  return /* @__PURE__ */ React.createElement("div", { className: "confirmation-page" }, isBankTransfer ? /* @__PURE__ */ React.createElement("div", { className: "confirmation-check", style: { background: "#fef3c7", borderColor: "#f59e0b" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "#92400e", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "10" }), /* @__PURE__ */ React.createElement("path", { d: "M12 6v6l4 2" }))) : /* @__PURE__ */ React.createElement("div", { className: "confirmation-check" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h1", null, isBankTransfer ? "Order Received" : "Order Confirmed"), order && /* @__PURE__ */ React.createElement("div", { className: "confirmation-order-number" }, "Order number: ", /* @__PURE__ */ React.createElement("strong", null, order.order_number)), isBankTransfer && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.9375rem", color: "var(--stone-600)", marginBottom: "1.5rem", lineHeight: 1.6 } }, "Your order is being held while we await your bank transfer. Please send payment using the details below."), isBankTransfer && bankInstructions && /* @__PURE__ */ React.createElement("div", { className: "bank-transfer-instructions" }, /* @__PURE__ */ React.createElement("h3", null, "Bank Transfer Details"), aba.bank_name && /* @__PURE__ */ React.createElement("div", { className: "bank-instruction-row" }, /* @__PURE__ */ React.createElement("span", { className: "bank-label" }, "Bank Name"), /* @__PURE__ */ React.createElement("span", { className: "bank-value" }, aba.bank_name)), aba.routing_number && /* @__PURE__ */ React.createElement("div", { className: "bank-instruction-row" }, /* @__PURE__ */ React.createElement("span", { className: "bank-label" }, "Routing Number"), /* @__PURE__ */ React.createElement("span", { className: "bank-value" }, aba.routing_number)), aba.account_number && /* @__PURE__ */ React.createElement("div", { className: "bank-instruction-row" }, /* @__PURE__ */ React.createElement("span", { className: "bank-label" }, "Account Number"), /* @__PURE__ */ React.createElement("span", { className: "bank-value" }, aba.account_number)), bi.reference && /* @__PURE__ */ React.createElement("div", { className: "bank-instruction-row" }, /* @__PURE__ */ React.createElement("span", { className: "bank-label" }, "Reference"), /* @__PURE__ */ React.createElement("span", { className: "bank-value" }, bi.reference)), /* @__PURE__ */ React.createElement("div", { className: "bank-instruction-row", style: { borderTop: "1px solid #fde68a", marginTop: "0.25rem", paddingTop: "0.75rem" } }, /* @__PURE__ */ React.createElement("span", { className: "bank-label", style: { fontWeight: 600 } }, "Amount Due"), /* @__PURE__ */ React.createElement("span", { className: "bank-value", style: { fontSize: "1.125rem" } }, "$", order ? parseFloat(order.total || 0).toFixed(2) : "\u2014")), /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", padding: "0.75rem 1rem", fontSize: "0.8125rem", color: "#991b1b", marginTop: "1rem", borderRadius: "4px" } }, /* @__PURE__ */ React.createElement("strong", null, "Important:"), " Include the reference number in your transfer memo so we can match your payment."), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginTop: "0.75rem", lineHeight: 1.6 } }, "Payment typically takes 1\u20133 business days to arrive. Your order will be confirmed automatically once we receive the funds. Payment must be received within 14 days.")), items.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "confirmation-details" }, /* @__PURE__ */ React.createElement("h3", null, "Items Ordered"), items.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "confirmation-item" }, /* @__PURE__ */ React.createElement("span", null, item.product_name || "Product", item.sell_by === "unit" ? ` - Qty ${item.num_boxes}` : ` - ${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? "es" : ""}`), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, "$" + parseFloat(item.subtotal || 0).toFixed(2)))), /* @__PURE__ */ React.createElement("div", { className: "confirmation-item", style: { fontWeight: 600 } }, /* @__PURE__ */ React.createElement("span", null, "Total"), /* @__PURE__ */ React.createElement("span", null, "$", parseFloat(order.total || 0).toFixed(2)))), sampleRequest && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2rem", paddingTop: "2rem", borderTop: "1px solid var(--stone-200, #e7e5e4)" } }, /* @__PURE__ */ React.createElement("div", { className: "confirmation-check", style: { width: 40, height: 40 } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading, 'Cormorant Garamond', serif)", fontWeight: 400, marginBottom: "0.5rem" } }, "Sample Request Created"), /* @__PURE__ */ React.createElement("div", { className: "confirmation-order-number" }, "Request number: ", /* @__PURE__ */ React.createElement("strong", null, sampleRequest.request_number)), /* @__PURE__ */ React.createElement("div", { className: "confirmation-details" }, /* @__PURE__ */ React.createElement("h3", null, "Samples Requested"), sampleItems.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "confirmation-item" }, /* @__PURE__ */ React.createElement("span", null, item.product_name || "Product", item.variant_name ? " \u2014 " + item.variant_name : ""), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, color: "var(--stone-500, #78716c)" } }, "FREE"))), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-500, #78716c)", marginTop: "1rem" } }, "Your samples will be prepared and shipped separately."))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { marginTop: "2rem" }, onClick: goBrowse }, "Continue Shopping"));
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
    fetch(API + "/api/customer/orders", { headers: authHeaders }).then((r) => r.json()).then((data) => {
      setOrders(data.orders || []);
      setLoadingOrders(false);
    }).catch(() => setLoadingOrders(false));
    fetch(API + "/api/customer/sample-requests", { headers: authHeaders }).then((r) => r.json()).then((data) => {
      setSampleRequests(data.sample_requests || []);
      setLoadingSamples(false);
    }).catch(() => setLoadingSamples(false));
    fetch(API + "/api/customer/quotes", { headers: authHeaders }).then((r) => r.json()).then((data) => {
      setQuotes(data.quotes || []);
      setLoadingQuotes(false);
    }).catch(() => setLoadingQuotes(false));
    fetch(API + "/api/customer/visits", { headers: authHeaders }).then((r) => r.json()).then((data) => {
      setVisits(data.visits || []);
      setLoadingVisits(false);
    }).catch(() => setLoadingVisits(false));
  }, []);
  const refreshSamples = () => {
    fetch(API + "/api/customer/sample-requests", { headers: authHeaders }).then((r) => r.json()).then((data) => setSampleRequests(data.sample_requests || [])).catch(() => {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
      awaiting_payment: { bg: "#fef3c7", text: "#92400e" },
      confirmed: { bg: "#dbeafe", text: "#1e40af" },
      ready_for_pickup: { bg: "#f0fdf4", text: "#166534" },
      shipped: { bg: "#e0e7ff", text: "#3730a3" },
      delivered: { bg: "#dcfce7", text: "#166534" },
      cancelled: { bg: "#fef2f2", text: "#991b1b" }
    };
    const c = colors[status] || colors.pending;
    const label = status === "ready_for_pickup" ? "ready for pickup" : status === "awaiting_payment" ? "awaiting payment" : status;
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
    ), isExpanded && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, sr.tracking_number && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Tracking: ", sr.tracking_number, sr.shipped_at && /* @__PURE__ */ React.createElement("span", { style: { marginLeft: "0.5rem" } }, "(Shipped ", new Date(sr.shipped_at).toLocaleDateString(), ")")), sr.delivery_method === "pickup" && sr.status === "shipped" && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#166534" } }, "Your samples are ready for pickup at our showroom."), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Samples"), (sr.items || []).map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(item.primary_image, 100), alt: item.product_name, style: { width: 40, height: 40, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection), item.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.variant_name)), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.75rem", color: "var(--stone-400)", textTransform: "uppercase" } }, "Free")))), isOpen && (sr.items || []).length < 5 && /* @__PURE__ */ React.createElement("div", { style: { background: "#fff", border: "1px solid var(--stone-200)", padding: "1rem", marginTop: "0.5rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.75rem" } }, "Add Samples to This Request"), /* @__PURE__ */ React.createElement(
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
      return /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, style: { display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(sku.primary_image, 60), alt: "", style: { width: 32, height: 32, objectFit: "cover" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, sku.product_name || sku.collection), sku.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, sku.variant_name)), alreadyAdded ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.6875rem", color: "var(--stone-400)" } }, "Added") : /* @__PURE__ */ React.createElement(
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
  ), expandedVisit === v.id && visitDetail && /* @__PURE__ */ React.createElement("div", { style: { padding: "1.25rem", borderTop: "1px solid var(--stone-200)", background: "var(--stone-50)" } }, v.message && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af", fontStyle: "italic" } }, '"', v.message, '"'), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Recommended Products"), visitDetail.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, style: { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--stone-100)", fontSize: "0.8125rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(item.primary_image, 100), alt: item.product_name, style: { width: 48, height: 48, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" }), /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection), item.variant_name && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.variant_name)), item.retail_price && /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500, whiteSpace: "nowrap" } }, "$", displayPrice(item, item.retail_price).toFixed(2), priceSuffix(item)), item.rep_note && /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.75rem", color: "var(--stone-500)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: item.rep_note }, item.rep_note))))))))), tab === "profile" && /* @__PURE__ */ React.createElement("div", null, profileMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileMsg), profileError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileError), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "First Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: firstName, onChange: (e) => setFirstName(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Last Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: lastName, onChange: (e) => setLastName(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Email"), /* @__PURE__ */ React.createElement("input", { style: { ...inputStyle, background: "var(--stone-100)", color: "var(--stone-500)" }, value: customer.email, readOnly: true })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Phone"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "tel", value: phone, onChange: (e) => setPhone(formatPhone(e.target.value)), placeholder: "(555) 123-4567" })), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginTop: "1.5rem", marginBottom: "1rem" } }, "Saved Address"), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 1"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine1, onChange: (e) => setAddressLine1(e.target.value), placeholder: "123 Main Street" })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 2"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine2, onChange: (e) => setAddressLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "City"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: city, onChange: (e) => setCity(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "State"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, padding: "0.65rem 0.5rem" }, value: addrState, onChange: (e) => setAddrState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "ZIP"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: zip, onChange: (e) => setZip(e.target.value) }))), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveProfile, disabled: saving, style: { marginBottom: "2.5rem" } }, saving ? "Saving..." : "Save Changes"), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginBottom: "1rem", paddingTop: "1.5rem", borderTop: "1px solid var(--stone-200)" } }, "Change Password"), pwMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwMsg), pwError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwError), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Current Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: currentPw, onChange: (e) => setCurrentPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: newPw, onChange: (e) => setNewPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Confirm New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: confirmPw, onChange: (e) => setConfirmPw(e.target.value) }))), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginBottom: "1rem" } }, "8+ characters, 1 uppercase letter, 1 number"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: changePassword, disabled: pwSaving }, pwSaving ? "Updating..." : "Update Password")));
}
function WishlistPage({ wishlist, toggleWishlist, onSkuClick, goBrowse, recentlyViewed, goHome }) {
  const [skus, setSkus] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (wishlist.length === 0) {
      setSkus([]);
      setLoading(false);
      return;
    }
    const productIds = wishlist.join(",");
    fetch(API + "/api/storefront/skus?product_ids=" + encodeURIComponent(productIds) + "&limit=" + wishlist.length * 2).then((r) => r.json()).then((data) => {
      const all = data.skus || [];
      const seen = /* @__PURE__ */ new Set();
      const wishlisted = [];
      all.forEach((sku) => {
        if (wishlist.includes(sku.product_id) && !seen.has(sku.product_id)) {
          seen.add(sku.product_id);
          wishlisted.push(sku);
        }
      });
      setSkus(wishlisted);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [wishlist]);
  return /* @__PURE__ */ React.createElement("div", { className: "wishlist-page" }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: [
    { label: "Home", onClick: goHome },
    { label: "Wishlist" }
  ] }), /* @__PURE__ */ React.createElement("h1", null, "Wishlist ", /* @__PURE__ */ React.createElement("span", { style: { fontSize: "1.25rem", color: "var(--stone-600)", fontWeight: 300 } }, "(", wishlist.length, ")")), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 4 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "wishlist-empty" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 56, height: 56, color: "var(--stone-300)", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.75rem", fontWeight: 300, marginBottom: "0.5rem" } }, "Your Wishlist is Empty"), /* @__PURE__ */ React.createElement("p", null, "Save your favorite products by clicking the heart icon while you browse."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse, style: { marginTop: "0.5rem" } }, "Browse Products"), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem", textAlign: "left" } }, /* @__PURE__ */ React.createElement("h3", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem", textAlign: "center" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, /* @__PURE__ */ React.createElement("img", { src: rv.primary_image ? thumbUrl(rv.primary_image, 200) : PLACEHOLDER_SVG, alt: rv.product_name, loading: "lazy", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, fullProductName(rv)), rv.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", displayPrice(rv, rv.retail_price).toFixed(2), priceSuffix(rv))))))) : /* @__PURE__ */ React.createElement("div", { className: "sku-grid" }, skus.map((sku) => /* @__PURE__ */ React.createElement(
    SkuCard,
    {
      key: sku.sku_id,
      sku,
      onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection, sku.category_slug, sku.product_slug),
      isWished: true,
      onToggleWishlist: () => toggleWishlist(sku.product_id)
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
      fetch(API + "/api/trade/dashboard", { headers: authHeaders }).then((r) => r.json()).then((d) => {
        setDashData(d);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "orders") {
      Promise.all([
        fetch(API + "/api/trade/orders", { headers: authHeaders }).then((r) => r.json()),
        fetch(API + "/api/trade/projects", { headers: authHeaders }).then((r) => r.json()).catch(() => ({ projects: [] }))
      ]).then(([od, pd]) => {
        setOrders(od.orders || []);
        setProjects(pd.projects || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "projects") {
      fetch(API + "/api/trade/projects", { headers: authHeaders }).then((r) => r.json()).then((d) => {
        setProjects(d.projects || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "favorites") {
      fetch(API + "/api/trade/favorites", { headers: authHeaders }).then((r) => r.json()).then((d) => {
        setFavorites(d.collections || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "quotes") {
      fetch(API + "/api/trade/quotes", { headers: authHeaders }).then((r) => r.json()).then((d) => {
        setQuotes(d.quotes || []);
        setExpandedQuote(null);
        setQuoteDetail(null);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "visits") {
      fetch(API + "/api/trade/visits", { headers: authHeaders }).then((r) => r.json()).then((d) => {
        setVisits(d.visits || []);
        setExpandedVisit(null);
        setVisitDetail(null);
        setLoading(false);
      }).catch(() => setLoading(false));
    } else if (t === "account") {
      Promise.all([
        fetch(API + "/api/trade/account", { headers: authHeaders }).then((r) => r.json()),
        fetch(API + "/api/trade/membership", { headers: authHeaders }).then((r) => r.json()).catch(() => ({})),
        fetch(API + "/api/trade/my-rep", { headers: authHeaders }).then((r) => r.json()).catch(() => ({}))
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
  const downloadQuotePdf = (quoteId) => {
    window.open(API + "/api/trade/quotes/" + quoteId + "/pdf?token=" + tradeToken, "_blank");
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
  } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" })))), expandedVisit === v.id && visitDetail && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: "4", style: { padding: "1rem 1.5rem", background: "#fafaf9" } }, v.message && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af", fontStyle: "italic", borderRadius: "4px" } }, '"', v.message, '"'), /* @__PURE__ */ React.createElement("table", { style: { width: "100%", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", { style: { borderBottom: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, width: 56 } }), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Product"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Variant"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500, textAlign: "right" } }, "Price"), /* @__PURE__ */ React.createElement("th", { style: { padding: "0.5rem", fontWeight: 500 } }, "Note"))), /* @__PURE__ */ React.createElement("tbody", null, (visitDetail.items || []).map((item, i) => /* @__PURE__ */ React.createElement("tr", { key: i, style: { borderBottom: "1px solid #e7e5e4" } }, /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem" } }, item.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(item.primary_image, 100), alt: "", style: { width: 40, height: 40, objectFit: "cover", border: "1px solid var(--stone-200)" }, loading: "lazy" })), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.product_name), item.collection && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-500)" } }, item.collection)), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", color: "var(--stone-600)" } }, item.variant_name || "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", textAlign: "right" } }, item.retail_price ? `$${displayPrice(item, item.retail_price).toFixed(2)}${priceSuffix(item)}` : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { padding: "0.5rem", color: "var(--stone-500)", fontSize: "0.75rem", maxWidth: 180 } }, item.rep_note || "")))))))))))) : /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" })), /* @__PURE__ */ React.createElement("p", null, "No showroom visits yet. After visiting our showroom, your product recommendations will appear here."))), tab === "projects" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, projects.length, " project", projects.length !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
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
  )), col.items && col.items.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-fav-grid" }, col.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "trade-fav-item" }, item.primary_image_url ? /* @__PURE__ */ React.createElement("img", { src: thumbUrl(item.primary_image_url, 200), alt: item.product_name, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { style: { height: 140, background: "var(--stone-100)" } }), /* @__PURE__ */ React.createElement("div", { className: "name" }, item.product_name), /* @__PURE__ */ React.createElement(
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
    fetch(API + "/api/collections").then((r) => r.json()).then((data) => {
      setCollections(data.collections || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);
  return /* @__PURE__ */ React.createElement("div", { className: "collections-page" }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: [
    { label: "Home", onClick: goHome },
    { label: "Collections" }
  ] }), /* @__PURE__ */ React.createElement("h1", null, "Collections"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our curated flooring collections from premium vendors worldwide."), loading ? /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-collection-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })))) : collections.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", null, "No collections available yet.")) : /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, collections.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.slug, className: "collection-card", onClick: () => onCollectionClick(c.name) }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-image" }, /* @__PURE__ */ React.createElement("img", { src: c.image ? thumbUrl(c.image, 400) : PLACEHOLDER_SVG, alt: c.name, loading: "lazy", decoding: "async", onError: handleImgError })), /* @__PURE__ */ React.createElement("div", { className: "collection-card-info" }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-name" }, c.name), /* @__PURE__ */ React.createElement("div", { className: "collection-card-count" }, c.product_count, " product", c.product_count !== 1 ? "s" : ""))))));
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
    onSkuClick(sku.sku_id, sku.product_name, sku.category_slug, sku.product_slug);
  } }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { src: thumbUrl(sku.primary_image, 400), alt: sku.product_name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-info" }, /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-name" }, sku.product_name), /* @__PURE__ */ React.createElement("div", { className: "quiz-result-card-price" }, sku.retail_price ? "$" + displayPrice(sku, sku.retail_price).toFixed(2) + priceSuffix(sku) : ""))))), /* @__PURE__ */ React.createElement("button", { className: "quiz-view-all", onClick: () => {
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
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Upload failed");
        setUploading("");
        return;
      }
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
    if (step === 3 && !cardMounted.current && setupIntentSecret && stripeInstance) {
      setTimeout(() => {
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
  return /* @__PURE__ */ React.createElement("div", { className: "trade-modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "trade-modal", onClick: (e) => e.stopPropagation(), style: mode === "register" ? { maxWidth: "480px" } : {} }, /* @__PURE__ */ React.createElement("button", { className: "trade-modal-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", marginBottom: "1.5rem" } }, mode === "login" ? "Trade Login" : step === 4 ? "Application Submitted" : "Trade Registration"), error && /* @__PURE__ */ React.createElement("div", { className: "trade-msg trade-msg-error" }, error), success && /* @__PURE__ */ React.createElement("div", { className: "trade-msg trade-msg-success" }, success), mode === "login" ? /* @__PURE__ */ React.createElement("form", { onSubmit: handleLogin }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Password"), /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), required: true })), /* @__PURE__ */ React.createElement("button", { className: "btn", type: "submit", disabled: loading, style: { width: "100%", marginTop: "0.5rem" } }, loading ? "Signing in..." : "Sign In"), /* @__PURE__ */ React.createElement("div", { className: "trade-toggle" }, "Don't have an account? ", /* @__PURE__ */ React.createElement("a", { onClick: () => {
    setMode("register");
    setError("");
    setSuccess("");
  } }, "Apply for Trade"))) : step === 4 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "1rem 0" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", lineHeight: 1.6, marginBottom: "1.5rem" } }, "Your application is under review. You'll receive an email once approved."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: onClose, style: { width: "100%" } }, "Close")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "trade-steps-indicator" }, stepLabels.slice(0, 3).map((s, i) => /* @__PURE__ */ React.createElement("div", { key: s, className: "trade-step-dot" + (step === i + 1 ? " active" : step > i + 1 ? " done" : "") }, s))), step === 1 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Company Name *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: companyName, onChange: (e) => setCompanyName(e.target.value), autoComplete: "organization" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Contact Name *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: contactName, onChange: (e) => setContactName(e.target.value), autoComplete: "name" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Business Type *"), /* @__PURE__ */ React.createElement("select", { value: businessType, onChange: (e) => setBusinessType(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select..."), /* @__PURE__ */ React.createElement("option", { value: "contractor" }, "General Contractor"), /* @__PURE__ */ React.createElement("option", { value: "interior_designer" }, "Interior Designer"), /* @__PURE__ */ React.createElement("option", { value: "architect" }, "Architect"), /* @__PURE__ */ React.createElement("option", { value: "builder" }, "Builder / Developer"), /* @__PURE__ */ React.createElement("option", { value: "retailer" }, "Flooring Retailer"), /* @__PURE__ */ React.createElement("option", { value: "other" }, "Other"))), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), onBlur: () => setEmailTouched(true), autoComplete: "email", style: emailTouched && email && !emailValid ? { borderColor: "#dc2626" } : {} }), emailTouched && email && !emailValid && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: "#dc2626" } }, "Please enter a valid email")), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone *"), /* @__PURE__ */ React.createElement("input", { type: "tel", value: phone, onChange: handlePhoneChange, autoComplete: "tel", placeholder: "(555) 123-4567" }))), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Address *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: addressLine1, onChange: (e) => setAddressLine1(e.target.value), autoComplete: "address-line1", placeholder: "Street address" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "City *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: city, onChange: (e) => setCity(e.target.value), autoComplete: "address-level2" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "State *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: addrState, onChange: (e) => setAddrState(e.target.value), maxLength: "2", placeholder: "CA", style: { textTransform: "uppercase" }, autoComplete: "address-level1" })), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Zip *"), /* @__PURE__ */ React.createElement("input", { type: "text", value: zip, onChange: (e) => setZip(e.target.value), maxLength: "10", placeholder: "90210", autoComplete: "postal-code" }))), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Password *"), /* @__PURE__ */ React.createElement("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), autoComplete: "new-password" }), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: password ? passwordValid ? "#16a34a" : "var(--stone-400)" : "var(--stone-400)" } }, "Min 8 characters, one uppercase, one number")), /* @__PURE__ */ React.createElement("div", { className: "trade-field" }, /* @__PURE__ */ React.createElement("label", null, "Confirm Password *"), /* @__PURE__ */ React.createElement("input", { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value), autoComplete: "new-password" }), confirmPassword && confirmPassword !== password && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.7rem", marginTop: "0.35rem", color: "#dc2626" } }, "Passwords do not match")), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goStep2, style: { width: "100%", marginTop: "0.5rem" } }, "Continue"), /* @__PURE__ */ React.createElement("div", { className: "trade-toggle" }, "Already have an account? ", /* @__PURE__ */ React.createElement("a", { onClick: () => {
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
function CustomerAuthModal({ onClose, onLogin, initialMode }) {
  const [mode, setMode] = useState(initialMode || "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
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
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      onLogin(data.token, data.customer);
    } catch {
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
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      onLogin(data.token, data.customer);
    } catch {
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
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setSuccess("If an account exists with that email, a reset link has been sent.");
      setLoading(false);
    } catch {
      setError("Unable to send reset email. Please try again.");
      setLoading(false);
    }
  };
  const switchMode = (newMode) => {
    setMode(newMode);
    setError("");
    setSuccess("");
  };
  return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal-content", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("h2", null, mode === "login" ? "Sign In" : mode === "register" ? "Create Account" : "Reset Password"), mode === "forgot" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Enter your email and we'll send you a link to reset your password."), /* @__PURE__ */ React.createElement("form", { onSubmit: handleForgotPassword }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), success && /* @__PURE__ */ React.createElement("div", { style: { padding: "0.75rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4, fontSize: "0.875rem", color: "#166534", marginBottom: "1rem" } }, success), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" }, disabled: loading || !!success }, loading ? "..." : "Send Reset Link")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginTop: "1.5rem", fontSize: "0.875rem" } }, /* @__PURE__ */ React.createElement("a", { onClick: () => switchMode("login"), style: { color: "var(--gold)", cursor: "pointer" } }, "Back to Sign In"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("form", { onSubmit: mode === "login" ? handleLogin : handleRegister }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), mode === "register" && /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "First Name"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: firstName, onChange: (e) => setFirstName(e.target.value) })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Last Name"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: lastName, onChange: (e) => setLastName(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value) })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Password"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "password", value: password, onChange: (e) => setPassword(e.target.value) })), mode === "login" && /* @__PURE__ */ React.createElement("div", { style: { textAlign: "right", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("a", { onClick: () => switchMode("forgot"), style: { fontSize: "0.8125rem", color: "var(--gold)", cursor: "pointer" } }, "Forgot password?")), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" }, disabled: loading }, loading ? "..." : mode === "login" ? "Sign In" : "Create Account")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", marginTop: "1.5rem", fontSize: "0.875rem" } }, mode === "login" ? /* @__PURE__ */ React.createElement("span", null, "No account? ", /* @__PURE__ */ React.createElement("a", { onClick: () => switchMode("register"), style: { color: "var(--gold)", cursor: "pointer" } }, "Create one")) : /* @__PURE__ */ React.createElement("span", null, "Have an account? ", /* @__PURE__ */ React.createElement("a", { onClick: () => switchMode("login"), style: { color: "var(--gold)", cursor: "pointer" } }, "Sign in"))))));
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
    } catch {
      setError("Unable to submit. Please try again.");
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal-content", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "\xD7"), submitted ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "2rem 0" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, borderRadius: "50%", background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.5rem" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "#059669", strokeWidth: "2", style: { width: 30, height: 30 } }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h2", { style: { marginBottom: "0.5rem" } }, "Thank You!"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.95rem" } }, "We'll be in touch within 1 business day.")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "Request Installation Quote"), product && /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.875rem", marginBottom: "1.5rem" } }, "For: ", fullProductName(product)), /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Name *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: name, onChange: (e) => setName(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "tel", value: phone, onChange: (e) => setPhone(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "ZIP Code"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: zipCode, onChange: (e) => setZipCode(e.target.value), maxLength: 5 })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Est. Square Feet"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "number", value: sqft, onChange: (e) => setSqft(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Message"), /* @__PURE__ */ React.createElement("textarea", { className: "checkout-input", value: message, onChange: (e) => setMessage(e.target.value), rows: 3, style: { resize: "vertical" } })), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" } }, "Submit Inquiry")))));
}
function InstallationPage({ onRequestQuote }) {
  return /* @__PURE__ */ React.createElement("div", { className: "installation-page" }, /* @__PURE__ */ React.createElement("div", { className: "install-hero" }, /* @__PURE__ */ React.createElement("h1", null, "Professional Installation"), /* @__PURE__ */ React.createElement("p", null, "Licensed and insured installers with decades of combined experience. From hardwood to tile, we ensure a flawless finish on every project."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onRequestQuote }, "Request a Free Quote")), /* @__PURE__ */ React.createElement("div", { className: "install-types" }, /* @__PURE__ */ React.createElement("h2", null, "What We Install"), /* @__PURE__ */ React.createElement("div", { className: "install-types-grid" }, /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7" })), /* @__PURE__ */ React.createElement("h3", null, "Hardwood"), /* @__PURE__ */ React.createElement("p", null, "Solid and engineered hardwood installation with precision nailing, glue-down, or floating methods.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "3", x2: "12", y2: "21" })), /* @__PURE__ */ React.createElement("h3", null, "Tile & Porcelain"), /* @__PURE__ */ React.createElement("p", null, "Floor and wall tile installation including mortar-set, large-format, and mosaic applications.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M2 20h20" }), /* @__PURE__ */ React.createElement("path", { d: "M4 20V8l4-4h8l4 4v12" }), /* @__PURE__ */ React.createElement("path", { d: "M2 20l4-4" }), /* @__PURE__ */ React.createElement("path", { d: "M22 20l-4-4" })), /* @__PURE__ */ React.createElement("h3", null, "Luxury Vinyl"), /* @__PURE__ */ React.createElement("p", null, "Click-lock LVP and glue-down LVT for waterproof, durable performance in any room.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 2L2 7l10 5 10-5-10-5z" }), /* @__PURE__ */ React.createElement("path", { d: "M2 17l10 5 10-5" }), /* @__PURE__ */ React.createElement("path", { d: "M2 12l10 5 10-5" })), /* @__PURE__ */ React.createElement("h3", null, "Natural Stone"), /* @__PURE__ */ React.createElement("p", null, "Marble, travertine, slate, and quartzite installed with expert care for lasting beauty.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M4 20c0-4 4-4 4-8s-4-4-4-8" }), /* @__PURE__ */ React.createElement("path", { d: "M12 20c0-4 4-4 4-8s-4-4-4-8" }), /* @__PURE__ */ React.createElement("path", { d: "M20 20c0-4 4-4 4-8s-4-4-4-8" })), /* @__PURE__ */ React.createElement("h3", null, "Carpet"), /* @__PURE__ */ React.createElement("p", null, "Stretch-in and direct-glue carpet installation for bedrooms, living spaces, and commercial areas.")), /* @__PURE__ */ React.createElement("div", { className: "install-type-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "2", y: "6", width: "20", height: "12", rx: "1" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "10", y1: "6", x2: "10", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "14", y1: "6", x2: "14", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "18", y2: "18" })), /* @__PURE__ */ React.createElement("h3", null, "Laminate"), /* @__PURE__ */ React.createElement("p", null, "Quick and affordable floating-floor laminate installation with seamless transitions.")))), /* @__PURE__ */ React.createElement("div", { className: "install-steps-section" }, /* @__PURE__ */ React.createElement("h2", null, "How It Works"), /* @__PURE__ */ React.createElement("div", { className: "install-steps" }, /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "1"), /* @__PURE__ */ React.createElement("h3", null, "Request a Quote"), /* @__PURE__ */ React.createElement("p", null, "Tell us about your project \u2014 flooring type, square footage, and timeline.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "2"), /* @__PURE__ */ React.createElement("h3", null, "Site Visit & Measure"), /* @__PURE__ */ React.createElement("p", null, "Our team visits your space for precise measurements and subfloor assessment.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "3"), /* @__PURE__ */ React.createElement("h3", null, "Schedule Installation"), /* @__PURE__ */ React.createElement("p", null, "Pick a date that works for you. We handle materials, prep, and cleanup.")), /* @__PURE__ */ React.createElement("div", { className: "install-step" }, /* @__PURE__ */ React.createElement("div", { className: "step-number" }, "4"), /* @__PURE__ */ React.createElement("h3", null, "Enjoy Your New Floors"), /* @__PURE__ */ React.createElement("p", null, "Walk-through inspection, care instructions, and warranty documentation provided.")))), /* @__PURE__ */ React.createElement("div", { className: "install-benefits" }, /* @__PURE__ */ React.createElement("h2", null, "Why Choose Us"), /* @__PURE__ */ React.createElement("div", { className: "install-benefits-grid" }, /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" })), /* @__PURE__ */ React.createElement("h3", null, "Licensed & Insured"), /* @__PURE__ */ React.createElement("p", null, "California Contractor License #830966. Fully bonded and insured for your protection.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "8", r: "7" }), /* @__PURE__ */ React.createElement("polyline", { points: "8.21 13.89 7 23 12 20 17 23 15.79 13.88" })), /* @__PURE__ */ React.createElement("h3", null, "Manufacturer Certified"), /* @__PURE__ */ React.createElement("p", null, "Factory-trained installers certified by leading flooring manufacturers.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" })), /* @__PURE__ */ React.createElement("h3", null, "Warranty Included"), /* @__PURE__ */ React.createElement("p", null, "Every installation backed by our workmanship warranty for your peace of mind.")), /* @__PURE__ */ React.createElement("div", { className: "benefit-card" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" })), /* @__PURE__ */ React.createElement("h3", null, "Free Estimates"), /* @__PURE__ */ React.createElement("p", null, "No-obligation quotes with transparent pricing. No hidden fees, ever.")))), /* @__PURE__ */ React.createElement("div", { className: "install-area" }, /* @__PURE__ */ React.createElement("h2", null, "Service Area"), /* @__PURE__ */ React.createElement("p", null, "We proudly serve Orange County and surrounding areas, including:"), /* @__PURE__ */ React.createElement("p", { className: "install-area-cities" }, "Anaheim \xB7 Fullerton \xB7 Irvine \xB7 Orange \xB7 Tustin \xB7 Santa Ana \xB7 Yorba Linda \xB7 Placentia \xB7 Brea \xB7 Buena Park \xB7 Huntington Beach \xB7 Costa Mesa \xB7 Newport Beach \xB7 Mission Viejo \xB7 Lake Forest \xB7 Laguna Hills")), /* @__PURE__ */ React.createElement("div", { className: "install-cta-band" }, /* @__PURE__ */ React.createElement("h2", null, "Ready to Get Started?"), /* @__PURE__ */ React.createElement("p", null, "Request a free, no-obligation quote and let our experts transform your space."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-gold", onClick: onRequestQuote }, "Request a Free Quote")));
}
function SalePage({ onSkuClick, wishlist, toggleWishlist, setQuickViewSku, navigate }) {
  const [skus, setSkus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("discount");
  const [stats, setStats] = useState({ count: 0, max_discount: 0 });
  const limit = 24;
  useEffect(() => {
    fetch("/api/storefront/sale/stats").then((r) => r.json()).then((data) => setStats(data)).catch(() => {
    });
  }, []);
  useEffect(() => {
    setLoading(true);
    const offset = (page - 1) * limit;
    fetch(`/api/storefront/skus?sale=true&sort=${sortBy}&limit=${limit}&offset=${offset}`).then((r) => r.json()).then((data) => {
      setSkus(data.skus || []);
      setTotal(data.total || 0);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [page, sortBy]);
  const totalPages = Math.ceil(total / limit);
  return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "sale-hero" }, /* @__PURE__ */ React.createElement("div", { className: "sale-hero-badge" }, "LIMITED TIME"), /* @__PURE__ */ React.createElement("h1", null, "Sale"), /* @__PURE__ */ React.createElement("p", null, "Exceptional flooring at extraordinary prices. Shop our curated selection of premium materials at reduced prices."), stats.count > 0 && /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stats" }, /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stat" }, /* @__PURE__ */ React.createElement("div", { className: "stat-value" }, stats.count), /* @__PURE__ */ React.createElement("div", { className: "stat-label" }, "Products on Sale")), /* @__PURE__ */ React.createElement("div", { className: "sale-hero-stat" }, /* @__PURE__ */ React.createElement("div", { className: "stat-value" }, "Up to ", stats.max_discount, "%"), /* @__PURE__ */ React.createElement("div", { className: "stat-label" }, "Savings")))), /* @__PURE__ */ React.createElement("div", { className: "sale-grid-section" }, loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "sale-empty" }, /* @__PURE__ */ React.createElement("h2", null, "No sale items right now"), /* @__PURE__ */ React.createElement("p", null, "Check back soon \u2014 we regularly add new deals on premium flooring."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => navigate("/shop") }, "Browse All Products")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sale-toolbar" }, /* @__PURE__ */ React.createElement("span", { className: "result-count" }, total, " product", total !== 1 ? "s" : "", " on sale"), /* @__PURE__ */ React.createElement("select", { value: sortBy, onChange: (e) => {
    setSortBy(e.target.value);
    setPage(1);
  } }, /* @__PURE__ */ React.createElement("option", { value: "discount" }, "Biggest Savings"), /* @__PURE__ */ React.createElement("option", { value: "price_asc" }, "Price: Low to High"), /* @__PURE__ */ React.createElement("option", { value: "price_desc" }, "Price: High to Low"), /* @__PURE__ */ React.createElement("option", { value: "newest" }, "Newest"), /* @__PURE__ */ React.createElement("option", { value: "name_asc" }, "Name: A\u2013Z"))), /* @__PURE__ */ React.createElement(SkuGrid, { skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }), totalPages > 1 && /* @__PURE__ */ React.createElement(Pagination, { currentPage: page, totalPages, onPageChange: (p) => {
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
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, /* @__PURE__ */ React.createElement("img", { src: item.primary_image ? thumbUrl(item.primary_image, 60) : PLACEHOLDER_SVG, alt: item.product_name, loading: "lazy", decoding: "async", onError: handleImgError })),
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, fullProductName(item)),
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, item.retail_price ? "$" + displayPrice(item, item.retail_price).toFixed(2) + priceSuffix(item) : ""),
    item.rep_note && /* @__PURE__ */ React.createElement("p", { style: { margin: "0.5rem 0 0", fontSize: "0.8125rem", fontStyle: "italic", color: "var(--stone-400)", lineHeight: 1.4 } }, '"', item.rep_note, '"')
  ))), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", paddingTop: "2rem", borderTop: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem", marginBottom: "0.25rem" } }, "Questions? Contact us at (714) 999-0009"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.8125rem" } }, "Roma Flooring Designs \xB7 1440 S. State College Blvd #6m, Anaheim, CA 92806")));
}
function ResetPasswordPage({ goHome, openLogin }) {
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
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setSuccess(true);
      window.history.replaceState({}, "", window.location.pathname);
    } catch {
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
  return /* @__PURE__ */ React.createElement("nav", { className: "breadcrumbs", "aria-label": "Breadcrumb" }, items.map((item, i) => /* @__PURE__ */ React.createElement(React.Fragment, { key: i }, i > 0 && /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, "/"), item.onClick ? /* @__PURE__ */ React.createElement("a", { onClick: item.onClick }, item.label) : /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-800)" } }, item.label))));
}
function SiteFooter({ goHome, goBrowse, goCollections, goTrade, onInstallClick }) {
  return /* @__PURE__ */ React.createElement("div", { className: "footer" }, /* @__PURE__ */ React.createElement("div", { className: "footer-inner" }, /* @__PURE__ */ React.createElement("div", { className: "footer-brand" }, /* @__PURE__ */ React.createElement("h3", null, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("p", null, "Premium flooring, tile, stone, and countertop products. Visit our showroom in Anaheim, CA or shop online."), /* @__PURE__ */ React.createElement("p", { style: { marginTop: "1rem", fontSize: "0.8125rem", color: "var(--stone-400)" } }, "1440 S. State College Blvd #6m", /* @__PURE__ */ React.createElement("br", null), "Anaheim, CA 92806", /* @__PURE__ */ React.createElement("br", null), "(714) 999-0009")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Shop"), /* @__PURE__ */ React.createElement("a", { onClick: goBrowse }, "All Products"), /* @__PURE__ */ React.createElement("a", { onClick: goCollections }, "Collections"), /* @__PURE__ */ React.createElement("a", { onClick: () => onInstallClick && onInstallClick() }, "Installation")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Trade"), /* @__PURE__ */ React.createElement("a", { onClick: goTrade }, "Trade Program"), /* @__PURE__ */ React.createElement("a", { onClick: goTrade }, "Apply Now")), /* @__PURE__ */ React.createElement("div", { className: "footer-col" }, /* @__PURE__ */ React.createElement("h4", null, "Company"), /* @__PURE__ */ React.createElement("a", { onClick: goHome }, "Home"), /* @__PURE__ */ React.createElement("a", { href: "mailto:Sales@romaflooringdesigns.com" }, "Contact"))), /* @__PURE__ */ React.createElement("div", { className: "footer-bottom" }, "\xA9 2026 Roma Flooring Designs. All rights reserved. License #830966"));
}
ReactDOM.createRoot(document.getElementById("root")).render(/* @__PURE__ */ React.createElement(ErrorBoundary, null, /* @__PURE__ */ React.createElement(StorefrontApp, null)));
