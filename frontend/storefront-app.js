const { useState, useEffect, useRef, useCallback } = React;
const API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:3001" : `${window.location.protocol}//${window.location.hostname}:3001`;
function getSessionId() {
  let id = localStorage.getItem("cart_session_id");
  if (!id) {
    id = "sess_" + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
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
  return sku.sell_by === "unit" || sku.price_basis === "per_unit";
}
function isCarpet(sku) {
  return sku && sku.cut_price != null;
}
function carpetSqydPrice(sqftPrice) {
  return (parseFloat(sqftPrice) * 9).toFixed(2);
}
function priceSuffix(sku) {
  if (isSoldPerUnit(sku)) return "/ea";
  return "/sqft";
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
const stripeInstance = typeof Stripe !== "undefined" ? Stripe("pk_test_51SzdrRAASarADPs5BQucZOHBLTPXAaFpGajCToKwXCjdVCasoYHDm3guDjMoEeQhhLr71AWiFPgq91BE2ggj2wNf004DucWYlf") : null;
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return React.createElement(
        "div",
        {
          style: { maxWidth: 600, margin: "6rem auto", textAlign: "center", padding: "2rem", fontFamily: "'Inter', system-ui, sans-serif" }
        },
        React.createElement("div", { style: { fontSize: "4rem", marginBottom: "1rem", color: "#a8a29e" } }, "\u26A0"),
        React.createElement("h1", { style: { fontFamily: "'Cormorant Garamond', serif", fontSize: "2rem", fontWeight: 300, marginBottom: "0.75rem" } }, "Something Went Wrong"),
        React.createElement(
          "p",
          { style: { color: "#78716c", marginBottom: "2rem", lineHeight: 1.6 } },
          "We\u2019re sorry, an unexpected error occurred. Please refresh the page to try again."
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
function StorefrontApp() {
  const [view, setView] = useState("home");
  const [selectedSkuId, setSelectedSkuId] = useState(null);
  const [skus, setSkus] = useState([]);
  const [totalSkus, setTotalSkus] = useState(0);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState({});
  const [facets, setFacets] = useState([]);
  const [sortBy, setSortBy] = useState("name_asc");
  const [loadingSkus, setLoadingSkus] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [featuredSkus, setFeaturedSkus] = useState([]);
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
  const [tradeCustomer, setTradeCustomer] = useState(null);
  const [tradeToken, setTradeToken] = useState(localStorage.getItem("trade_token") || null);
  const [customer, setCustomer] = useState(null);
  const [customerToken, setCustomerToken] = useState(localStorage.getItem("customer_token") || null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authModalMode, setAuthModalMode] = useState("login");
  const [showTradeModal, setShowTradeModal] = useState(false);
  const [tradeModalMode, setTradeModalMode] = useState("login");
  const [showInstallModal, setShowInstallModal] = useState(false);
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
      const updated = [{ sku_id: skuData.sku_id, product_name: skuData.product_name, variant_name: skuData.variant_name, primary_image: skuData.primary_image, retail_price: skuData.retail_price, price_basis: skuData.price_basis }, ...filtered].slice(0, 12);
      localStorage.setItem("recently_viewed", JSON.stringify(updated));
      return updated;
    });
  };
  const sessionId = useRef(getSessionId());
  const scrollY = useRef(0);
  const tradeHeaders = () => {
    const t = localStorage.getItem("trade_token");
    return t ? { "X-Trade-Token": t } : {};
  };
  const fetchSkusRef = useRef(null);
  const fetchFacetsRef = useRef(null);
  const fetchSkus = useCallback((opts = {}) => {
    const PAGE_SIZE = 72;
    const { cat, coll, search, activeFilters, sort, page } = {
      cat: selectedCategory,
      coll: selectedCollection,
      search: searchQuery,
      activeFilters: filters,
      sort: sortBy,
      page: currentPage,
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
      if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join(","));
    });
    setLoadingSkus(true);
    fetch(API + "/api/storefront/skus?" + params.toString(), { headers: tradeHeaders() }).then((r) => r.json()).then((data) => {
      setSkus(data.skus || []);
      setTotalSkus(data.total || 0);
      setLoadingSkus(false);
    }).catch((err) => {
      console.error(err);
      setLoadingSkus(false);
    });
  }, [selectedCategory, selectedCollection, searchQuery, filters, sortBy, currentPage]);
  const fetchFacets = useCallback((opts = {}) => {
    const { cat, coll, search, activeFilters } = {
      cat: selectedCategory,
      coll: selectedCollection,
      search: searchQuery,
      activeFilters: filters,
      ...opts
    };
    const params = new URLSearchParams();
    if (cat) params.set("category", cat);
    if (coll) params.set("collection", coll);
    if (search) params.set("q", search);
    const af = activeFilters || {};
    Object.keys(af).forEach((slug) => {
      if (af[slug] && af[slug].length > 0) params.set(slug, af[slug].join(","));
    });
    fetch(API + "/api/storefront/facets?" + params.toString()).then((r) => r.json()).then((data) => setFacets(data.facets || [])).catch((err) => console.error(err));
  }, [selectedCategory, selectedCollection, searchQuery, filters]);
  fetchSkusRef.current = fetchSkus;
  fetchFacetsRef.current = fetchFacets;
  const buildShopUrl = (cat, coll, search, af) => {
    const params = new URLSearchParams();
    if (cat) params.set("category", cat);
    if (coll) params.set("collection", coll);
    if (search) params.set("q", search);
    const f = af || {};
    Object.keys(f).forEach((slug) => {
      if (f[slug] && f[slug].length > 0) params.set(slug, f[slug].join(","));
    });
    const qs = params.toString();
    return "/shop" + (qs ? "?" + qs : "");
  };
  const pushShopUrl = (cat, coll, search, af, replace) => {
    const url = buildShopUrl(cat, coll, search, af);
    const state = { view: "browse", cat, coll, search, filters: af };
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
  const handleCollectionClick = (collectionName) => {
    setSelectedCategory(null);
    setSelectedCollection(collectionName);
    setFilters({});
    setCurrentPage(1);
    setView("browse");
    fetchSkus({ cat: null, coll: collectionName, activeFilters: {}, page: 1 });
    fetchFacets({ cat: null, coll: collectionName, activeFilters: {} });
    pushShopUrl(null, collectionName, "", {});
    window.scrollTo(0, 0);
  };
  const goBrowse = () => {
    setView("browse");
    setSelectedCollection(null);
    setSearchQuery("");
    setFilters({});
    setCurrentPage(1);
    const firstCat = categories.length > 0 ? categories[0].slug : null;
    setSelectedCategory(firstCat);
    fetchSkus({ cat: firstCat, coll: null, search: "", activeFilters: {}, page: 1 });
    fetchFacets({ cat: firstCat, coll: null, search: "", activeFilters: {} });
    pushShopUrl(firstCat, null, "", {});
    window.scrollTo(0, 0);
  };
  const goSkuDetail = (skuId, productName) => {
    scrollY.current = window.scrollY;
    setSelectedSkuId(skuId);
    setView("detail");
    const slug = generateSlug(productName || "product");
    history.pushState({ view: "detail", skuId }, "", "/shop/sku/" + skuId + "/" + slug);
    window.scrollTo(0, 0);
  };
  const goBackToBrowse = () => {
    setView("browse");
    pushShopUrl(selectedCategory, selectedCollection, searchQuery, filters);
    requestAnimationFrame(() => window.scrollTo(0, scrollY.current));
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
  const handleOrderComplete = (order) => {
    setCompletedOrder(order);
    setCart([]);
    setView("confirmation");
    window.scrollTo(0, 0);
  };
  const handleCategorySelect = (slug) => {
    setSelectedCategory(slug);
    setSelectedCollection(null);
    setFilters({});
    setCurrentPage(1);
    fetchSkus({ cat: slug, coll: null, activeFilters: {}, page: 1 });
    fetchFacets({ cat: slug, coll: null, activeFilters: {} });
    pushShopUrl(slug, null, searchQuery, {});
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
      pushShopUrl(selectedCategory, selectedCollection, searchQuery, updated, true);
      return updated;
    });
  };
  const handleClearFilters = () => {
    setFilters({});
    setCurrentPage(1);
    fetchSkus({ activeFilters: {}, page: 1 });
    fetchFacets({ activeFilters: {} });
    pushShopUrl(selectedCategory, selectedCollection, searchQuery, {}, true);
  };
  const handleSearch = (query) => {
    setSearchQuery(query);
    setSelectedCategory(null);
    setSelectedCollection(null);
    setFilters({});
    setCurrentPage(1);
    setView("browse");
    fetchSkus({ cat: null, coll: null, search: query, activeFilters: {}, page: 1 });
    fetchFacets({ cat: null, coll: null, search: query, activeFilters: {} });
    pushShopUrl(null, null, query, {});
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
    fetch(API + "/api/storefront/skus?limit=8&sort=newest").then((r) => r.json()).then((data) => setFeaturedSkus(data.skus || [])).catch(() => {
    });
    const path = window.location.pathname;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("reset_token")) {
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
      fetchSkus({ coll: slug, activeFilters: {} });
      fetchFacets({ coll: slug, activeFilters: {} });
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
    } else if (path === "/shop" || path.startsWith("/shop")) {
      setView("browse");
      const cat = sp.get("category");
      const coll = sp.get("collection");
      const q = sp.get("q");
      const af = {};
      sp.forEach((val, key) => {
        if (!["category", "collection", "q"].includes(key)) af[key] = val.split(",");
      });
      if (cat) setSelectedCategory(cat);
      if (coll) setSelectedCollection(coll);
      if (q) setSearchQuery(q);
      if (Object.keys(af).length) setFilters(af);
      fetchSkus({ cat, coll, search: q || "", activeFilters: af });
      fetchFacets({ cat, coll, search: q || "", activeFilters: af });
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
          setCurrentPage(1);
          fetchSkusRef.current({ cat: state.cat, coll: state.coll, search: state.search || "", activeFilters: state.filters || {}, page: 1 });
          fetchFacetsRef.current({ cat: state.cat, coll: state.coll, search: state.search || "", activeFilters: state.filters || {} });
        }
        if (state.view === "visit-recap" && state.token) setVisitRecapToken(state.token);
      } else {
        const p = window.location.pathname;
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
        } else if (p.startsWith("/visit/")) {
          setVisitRecapToken(p.replace("/visit/", ""));
          setView("visit-recap");
        } else {
          setView("browse");
          const sp2 = new URLSearchParams(window.location.search);
          const cat = sp2.get("category");
          const coll = sp2.get("collection");
          const q = sp2.get("q");
          const af = {};
          sp2.forEach((val, key) => {
            if (!["category", "collection", "q"].includes(key)) af[key] = val.split(",");
          });
          setSelectedCategory(cat);
          setSelectedCollection(coll);
          setSearchQuery(q || "");
          if (Object.keys(af).length) setFilters(af);
          setCurrentPage(1);
          fetchSkusRef.current({ cat, coll, search: q || "", activeFilters: af, page: 1 });
          fetchFacetsRef.current({ cat, coll, search: q || "", activeFilters: af });
        }
      }
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);
  useEffect(() => {
    if (view === "browse" && categories.length > 0 && !selectedCategory && !selectedCollection && !searchQuery) {
      const firstParent = categories[0];
      if (firstParent && firstParent.slug) {
        setSelectedCategory(firstParent.slug);
        fetchSkus({ cat: firstParent.slug, coll: null, search: "", activeFilters: filters, page: 1 });
        fetchFacets({ cat: firstParent.slug, coll: null, search: "", activeFilters: filters });
        pushShopUrl(firstParent.slug, null, "", filters, true);
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
      mobileNavOpen,
      setMobileNavOpen,
      mobileSearchOpen,
      setMobileSearchOpen,
      view
    }
  ), view === "home" && /* @__PURE__ */ React.createElement(
    HomePage,
    {
      featuredSkus,
      categories,
      onSkuClick: goSkuDetail,
      onCategorySelect: (slug) => {
        handleCategorySelect(slug);
        setView("browse");
      },
      goBrowse,
      goTrade,
      wishlist,
      toggleWishlist,
      setQuickViewSku
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
      goHome
    }
  ), view === "detail" && selectedSkuId && /* @__PURE__ */ React.createElement(
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
      setAppliedPromoCode
    }
  ), view === "confirmation" && /* @__PURE__ */ React.createElement(ConfirmationPage, { order: completedOrder, goBrowse }), view === "account" && (customer ? /* @__PURE__ */ React.createElement(AccountPage, { customer, customerToken, setCustomer, goBrowse }) : /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 600, margin: "4rem auto", textAlign: "center", padding: "0 2rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontWeight: 300, marginBottom: "1rem" } }, "Sign In Required"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", marginBottom: "1.5rem" } }, "Please sign in to view your account."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
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
  } }), /* @__PURE__ */ React.createElement(
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
      onSkuClick: goSkuDetail
    }
  ), showTradeModal && /* @__PURE__ */ React.createElement(TradeModal, { onClose: () => setShowTradeModal(false), onLogin: handleTradeLogin, initialMode: tradeModalMode }), showAuthModal && /* @__PURE__ */ React.createElement(CustomerAuthModal, { onClose: () => setShowAuthModal(false), onLogin: handleCustomerLogin, initialMode: authModalMode }), showInstallModal && /* @__PURE__ */ React.createElement(InstallationModal, { onClose: () => setShowInstallModal(false), product: installModalProduct }), /* @__PURE__ */ React.createElement(
    SiteFooter,
    {
      goHome,
      goBrowse,
      goCollections,
      goTrade,
      onInstallClick: () => {
        setInstallModalProduct(null);
        setShowInstallModal(true);
      }
    }
  ), /* @__PURE__ */ React.createElement(BackToTop, null), /* @__PURE__ */ React.createElement(ToastContainer, { toasts }));
}
function Header({ goHome, goBrowse, cart, cartDrawerOpen, setCartDrawerOpen, cartFlash, onSearch, onSkuClick, tradeCustomer, onTradeClick, onTradeLogout, customer, onAccountClick, onCustomerLogout, wishlistCount, goWishlist, goCollections, categories, onCategorySelect, mobileNavOpen, setMobileNavOpen, mobileSearchOpen, setMobileSearchOpen, view }) {
  const [searchInput, setSearchInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestTimerRef = useRef(null);
  const searchWrapRef = useRef(null);
  const itemCount = cart.length;
  const fetchSuggestions = (q) => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (!q || q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(API + "/api/storefront/skus?q=" + encodeURIComponent(q) + "&limit=6");
        const data = await res.json();
        setSuggestions(data.skus || []);
        setShowSuggestions(true);
        setActiveIdx(-1);
      } catch (e) {
        setSuggestions([]);
      }
    }, 250);
  };
  const handleSearchInput = (e) => {
    setSearchInput(e.target.value);
    fetchSuggestions(e.target.value);
  };
  const selectSuggestion = (sku) => {
    setShowSuggestions(false);
    setSearchInput("");
    setSuggestions([]);
    onSkuClick(sku.sku_id, sku.product_name || sku.collection);
  };
  const handleSearchKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) setShowSuggestions(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
  const megaCols = parentCats.map((parent) => ({
    name: parent.name,
    slug: parent.slug,
    children: categories.filter((c) => c.parent_id === parent.id)
  }));
  const searchForm = /* @__PURE__ */ React.createElement("form", { className: "header-search", ref: searchWrapRef, onSubmit: (e) => {
    e.preventDefault();
    const q = searchInput.trim();
    if (q) {
      onSearch(q);
      setShowSuggestions(false);
      setSearchInput("");
    }
  } }, /* @__PURE__ */ React.createElement("span", { className: "header-search-icon" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Search products...", value: searchInput, onChange: handleSearchInput, onKeyDown: handleSearchKeyDown, onFocus: () => {
    if (suggestions.length > 0) setShowSuggestions(true);
  } }), showSuggestions && suggestions.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "search-suggestions" }, suggestions.map((sku, i) => /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "search-suggestion" + (i === activeIdx ? " active" : ""), onClick: () => selectSuggestion(sku) }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { className: "search-suggestion-img", src: sku.primary_image, alt: "", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-text" }, /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-name" }, sku.product_name), /* @__PURE__ */ React.createElement("div", { className: "search-suggestion-variant" }, formatVariantName(sku.variant_name))), /* @__PURE__ */ React.createElement("span", { className: "search-suggestion-price" }, "$", parseFloat(sku.retail_price || 0).toFixed(2), sku.price_basis === "per_sqft" ? "/sf" : ""))), /* @__PURE__ */ React.createElement("div", { className: "search-view-all", onClick: () => {
    onSearch(searchInput.trim());
    setShowSuggestions(false);
    setSearchInput("");
  } }, "View all results")));
  return /* @__PURE__ */ React.createElement("header", null, /* @__PURE__ */ React.createElement("div", { className: "header-row-1" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("button", { className: "mobile-menu-btn", onClick: () => setMobileNavOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "18", x2: "21", y2: "18" }))), /* @__PURE__ */ React.createElement("div", { className: "logo", onClick: goHome }, /* @__PURE__ */ React.createElement("img", { src: "/assets/logo/roma-transparent.png", alt: "Roma Flooring Designs", width: "120", height: "44", decoding: "async" }))), searchForm, /* @__PURE__ */ React.createElement("div", { className: "header-actions" }, /* @__PURE__ */ React.createElement("button", { className: "mobile-search-btn", onClick: () => setMobileSearchOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("circle", { cx: "11", cy: "11", r: "8" }), /* @__PURE__ */ React.createElement("line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }))), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn", onClick: onAccountClick, title: customer ? customer.first_name : "Account" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "7", r: "4" }))), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn wishlist-header-wrap", onClick: goWishlist }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), wishlistCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "wishlist-badge" }, wishlistCount)), /* @__PURE__ */ React.createElement("button", { className: "header-action-btn" + (cartFlash ? " cart-flash" : ""), onClick: () => setCartDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })), itemCount > 0 && /* @__PURE__ */ React.createElement("span", { className: "cart-badge" }, itemCount)))), /* @__PURE__ */ React.createElement("div", { className: "header-row-2" }, /* @__PURE__ */ React.createElement("nav", { className: "header-nav" }, /* @__PURE__ */ React.createElement("div", { className: "header-nav-item" }, /* @__PURE__ */ React.createElement("button", { className: "header-nav-link" + (view === "browse" ? " active" : ""), onClick: goBrowse }, "Shop"), megaCols.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "mega-menu" }, /* @__PURE__ */ React.createElement("div", { className: "mega-menu-grid" }, megaCols.map((col) => /* @__PURE__ */ React.createElement("div", { key: col.slug, className: "mega-menu-col" }, /* @__PURE__ */ React.createElement("h4", null, /* @__PURE__ */ React.createElement("a", { onClick: () => onCategorySelect(col.slug) }, col.name)), col.children.map((child) => /* @__PURE__ */ React.createElement("a", { key: child.slug, onClick: () => onCategorySelect(child.slug) }, child.name)), col.children.length > 0 && /* @__PURE__ */ React.createElement("a", { className: "mega-menu-view-all", onClick: () => onCategorySelect(col.slug) }, "View All " + col.name + " \u2192")))))), /* @__PURE__ */ React.createElement("div", { className: "header-nav-item" }, /* @__PURE__ */ React.createElement("button", { className: "header-nav-link" + (view === "collections" ? " active" : ""), onClick: goCollections }, "Collections")), /* @__PURE__ */ React.createElement("div", { className: "header-nav-item" }, /* @__PURE__ */ React.createElement("button", { className: "header-nav-link" + (view === "trade" || view === "trade-dashboard" ? " active" : ""), onClick: onTradeClick }, tradeCustomer ? `Trade: ${tradeCustomer.company_name}` : "Trade")))));
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
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Cart (", itemCount, ")"), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: onClose }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), itemCount === 0 ? /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-empty" }, "Your cart is empty") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-items" }, cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "cart-drawer-item" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-img" }, item.primary_image && /* @__PURE__ */ React.createElement("img", { src: item.primary_image, alt: "", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-info" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-name" }, item.product_name || "Product", item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "sample-tag" }, "Sample")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-meta" }, item.is_sample ? "FREE SAMPLE" : item.sell_by === "unit" ? `Qty: ${item.num_boxes}` : `${item.price_tier ? "" : item.num_boxes + " box" + (parseInt(item.num_boxes) !== 1 ? "es" : "") + " \xB7 "}${parseFloat(item.sqft_needed || 0).toFixed(0)} sqft`, item.price_tier && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: item.price_tier === "roll" ? "var(--sage, #6b9080)" : "var(--stone-200)", color: item.price_tier === "roll" ? "white" : "var(--stone-600)" } }, item.price_tier === "roll" ? "Roll" : "Cut")), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-item-bottom" }, /* @__PURE__ */ React.createElement("span", { className: "cart-drawer-item-price" }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-item-remove", onClick: () => removeFromCart(item.id) }, "Remove")))))), /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-footer" }, /* @__PURE__ */ React.createElement("div", { className: "cart-drawer-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, onClick: () => {
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
    setActiveSku((prev) => ({ ...prev, sku_id: sib.sku_id, variant_name: sib.variant_name, retail_price: sib.retail_price, primary_image: sib.primary_image, sell_by: sib.sell_by, price_basis: sib.price_basis }));
    fetch("/api/storefront/skus/" + sib.sku_id, { headers: getTradeHeaders() }).then((r) => r.json()).then((data) => applyDetail(data));
  };
  const currentImg = media[imgIndex] || {};
  return /* @__PURE__ */ React.createElement("div", { className: "quick-view-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "quick-view", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "quick-view-close", onClick: onClose }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "quick-view-gallery" }, /* @__PURE__ */ React.createElement("div", { className: "quick-view-main-image" }, media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow left", disabled: imgIndex === 0, onClick: () => setImgIndex((i) => i - 1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" }))), currentImg.url && /* @__PURE__ */ React.createElement("img", { src: currentImg.url, alt: activeSku.product_name, decoding: "async" }), media.length > 1 && /* @__PURE__ */ React.createElement("button", { className: "quick-view-gallery-arrow right", disabled: imgIndex >= media.length - 1, onClick: () => setImgIndex((i) => i + 1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "9 18 15 12 9 6" })))), media.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-gallery-dots" }, media.map((_, i) => /* @__PURE__ */ React.createElement("span", { key: i, className: i === imgIndex ? "active" : "", onClick: () => setImgIndex(i) }))), siblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "quick-view-variants" }, /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "quick-view-variant-swatch active",
      title: formatVariantName(activeSku.variant_name)
    },
    (baseMediaRef.current[0] || {}).url && /* @__PURE__ */ React.createElement("img", { src: baseMediaRef.current[0].url, alt: activeSku.variant_name, decoding: "async" })
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
    sib.primary_image && /* @__PURE__ */ React.createElement("img", { src: sib.primary_image, alt: sib.variant_name, decoding: "async" })
  )))), /* @__PURE__ */ React.createElement("div", { className: "quick-view-info" }, /* @__PURE__ */ React.createElement("h2", null, activeSku.collection && activeSku.collection.toLowerCase() !== (activeSku.product_name || "").toLowerCase() ? `${activeSku.collection} ${activeSku.product_name}` : activeSku.product_name || activeSku.collection), activeSku.variant_name && /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginBottom: "0.5rem" } }, formatVariantName(activeSku.variant_name)), /* @__PURE__ */ React.createElement("div", { className: "price" }, activeSku.trade_price && activeSku.retail_price && /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "1rem", marginRight: "0.5rem" } }, "$", parseFloat(activeSku.retail_price).toFixed(2)), "$", parseFloat(activeSku.trade_price || activeSku.retail_price || 0).toFixed(2), /* @__PURE__ */ React.createElement("span", null, priceSuffix(activeSku))), activeSku.description_short && /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-600)", lineHeight: 1.6, marginBottom: "1rem" } }, activeSku.description_short), /* @__PURE__ */ React.createElement("div", { className: "quick-view-actions" }, isUnit ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => Math.max(1, q - 1)) }, "-"), /* @__PURE__ */ React.createElement("input", { type: "number", value: qty, onChange: (e) => setQty(Math.max(1, parseInt(e.target.value) || 1)) }), /* @__PURE__ */ React.createElement("button", { onClick: () => setQty((q) => q + 1) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: handleAdd }, "Add to Cart")) : /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, "Use the coverage calculator on the detail page to add this item to your cart."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: () => onViewDetail(activeSku.sku_id, activeSku.product_name) }, "View Full Details")))));
}
function MobileNav({ open, onClose, categories, onCategorySelect, goHome, goBrowse, goCollections, goTrade, goAccount, customer, tradeCustomer, onTradeClick, onCustomerLogout, onTradeLogout }) {
  const [expandedCat, setExpandedCat] = useState(null);
  const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
  const handleCatClick = (cat) => {
    if (expandedCat === cat.id) {
      setExpandedCat(null);
      return;
    }
    const children = categories.filter((c) => c.parent_id === cat.id);
    if (children.length > 0) {
      setExpandedCat(cat.id);
    } else {
      onCategorySelect(cat.slug);
      onClose();
    }
  };
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-overlay" + (open ? " open" : ""), onClick: onClose }), /* @__PURE__ */ React.createElement("nav", { className: "mobile-nav" + (open ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-head" }, /* @__PURE__ */ React.createElement("span", { style: { fontFamily: "var(--font-heading)", fontSize: "1.25rem", fontWeight: 600 } }, "Menu"), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", fontSize: "1.5rem", color: "var(--stone-500)", cursor: "pointer" } }, "\xD7")), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-links" }, /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goHome();
    onClose();
  } }, "Home"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goBrowse();
    onClose();
  } }, "Shop All"), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-accordion" }, /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-accordion-header", onClick: () => setExpandedCat(expandedCat === "cats" ? null : "cats") }, /* @__PURE__ */ React.createElement("span", null, "Categories"), /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16, transform: expandedCat === "cats" ? "rotate(180deg)" : "none", transition: "transform 0.2s" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }))), expandedCat === "cats" && /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-accordion-body" }, parentCats.map((cat) => {
    const children = categories.filter((c) => c.parent_id === cat.id);
    return /* @__PURE__ */ React.createElement("div", { key: cat.id }, /* @__PURE__ */ React.createElement("a", { onClick: () => {
      onCategorySelect(cat.slug);
      onClose();
    }, style: { fontWeight: 500 } }, cat.name), children.map((child) => /* @__PURE__ */ React.createElement("a", { key: child.id, onClick: () => {
      onCategorySelect(child.slug);
      onClose();
    }, style: { paddingLeft: "1.5rem", fontSize: "0.8125rem" } }, child.name)));
  }))), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goCollections();
    onClose();
  } }, "Collections"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goTrade();
    onClose();
  } }, "Trade Program")), /* @__PURE__ */ React.createElement("div", { className: "mobile-nav-footer" }, customer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Signed in as ", customer.first_name || customer.email), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goAccount();
    onClose();
  } }, "My Account"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    onCustomerLogout();
    onClose();
  } }, "Sign Out")) : tradeCustomer ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)", marginBottom: "0.5rem" } }, "Trade: ", tradeCustomer.company_name), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    onTradeLogout();
    onClose();
  } }, "Sign Out")) : /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("a", { onClick: () => {
    goAccount();
    onClose();
  } }, "Sign In"), /* @__PURE__ */ React.createElement("a", { onClick: () => {
    onTradeClick();
    onClose();
  } }, "Trade Login")))));
}
function MobileSearchOverlay({ open, onClose, onSearch, onSkuClick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current.focus(), 100);
    }
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);
  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(API + "/api/storefront/skus?search=" + encodeURIComponent(query) + "&limit=8");
        const data = await res.json();
        setResults(data.skus || []);
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 300);
  }, [query]);
  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
      onClose();
    }
  };
  return open ? /* @__PURE__ */ React.createElement("div", { className: "mobile-search-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "mobile-search-header" }, /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit, style: { flex: 1, display: "flex", gap: "0.5rem" } }, /* @__PURE__ */ React.createElement("input", { ref: inputRef, className: "mobile-search-input", type: "text", placeholder: "Search products...", value: query, onChange: (e) => setQuery(e.target.value) })), /* @__PURE__ */ React.createElement("button", { className: "mobile-search-close", onClick: onClose }, "Cancel")), results.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "mobile-search-results" }, results.map((sku) => /* @__PURE__ */ React.createElement("div", { key: sku.sku_id, className: "mobile-search-result", onClick: () => {
    onSkuClick(sku.sku_id, sku.product_name);
    onClose();
  } }, /* @__PURE__ */ React.createElement("div", { className: "mobile-search-result-img" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { src: sku.primary_image, alt: "", decoding: "async" })), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, fontSize: "0.875rem" } }, sku.product_name), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-500)" } }, "$", parseFloat(sku.retail_price || 0).toFixed(2), priceSuffix(sku)))))), loading && /* @__PURE__ */ React.createElement("div", { style: { padding: "0.5rem 1rem" } }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "skeleton-search-result" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-search-lines" }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short", style: { marginTop: 0 } }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })))))) : null;
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
  return /* @__PURE__ */ React.createElement("div", { className: "category-carousel" }, /* @__PURE__ */ React.createElement("button", { className: "carousel-arrow carousel-arrow-left", disabled: clamped === 0, onClick: () => go(-1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "15 18 9 12 15 6" }))), /* @__PURE__ */ React.createElement("div", { className: "category-carousel-track", ref: trackRef }, categories.map((cat) => /* @__PURE__ */ React.createElement("div", { key: cat.slug, className: "category-tile", onClick: () => onCategorySelect(cat.slug) }, cat.image_url && /* @__PURE__ */ React.createElement("img", { src: cat.image_url, alt: cat.name, loading: "lazy", decoding: "async" }), /* @__PURE__ */ React.createElement("div", { className: "category-tile-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "category-tile-name" }, cat.name), /* @__PURE__ */ React.createElement("span", { className: "category-tile-count" }, cat.product_count, " products"))))), /* @__PURE__ */ React.createElement("button", { className: "carousel-arrow carousel-arrow-right", disabled: clamped >= maxIndex, onClick: () => go(1) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("polyline", { points: "9 18 15 12 9 6" }))), maxIndex > 0 && /* @__PURE__ */ React.createElement("div", { className: "carousel-dots" }, Array.from({ length: maxIndex + 1 }, (_, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "carousel-dot" + (i === clamped ? " active" : ""), onClick: () => setIndex(i) }))));
}
function HomePage({ featuredSkus, categories, onSkuClick, onCategorySelect, goBrowse, goTrade, wishlist, toggleWishlist, setQuickViewSku }) {
  const parentCats = categories.filter((c) => !c.parent_id && c.product_count > 0);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("section", { className: "hero" }, /* @__PURE__ */ React.createElement("div", { className: "hero-bg", style: { backgroundImage: "url(/uploads/hero-bg.jpg)" } }), /* @__PURE__ */ React.createElement("div", { className: "hero-content" }, /* @__PURE__ */ React.createElement("h1", null, "Surfaces Crafted for Living"), /* @__PURE__ */ React.createElement("p", null, "Premium flooring, tile, and stone from the world's finest manufacturers. Discover materials that transform spaces."), /* @__PURE__ */ React.createElement("button", { className: "hero-cta", onClick: goBrowse }, "Shop Now"))), parentCats.length > 0 && /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "Shop by Category"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our curated selection of premium surfaces"), /* @__PURE__ */ React.createElement(CategoryCarousel, { categories: parentCats, onCategorySelect })), featuredSkus.length > 0 && /* @__PURE__ */ React.createElement("section", { className: "homepage-section" }, /* @__PURE__ */ React.createElement("h2", null, "New Arrivals"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "The latest additions to our collection"), /* @__PURE__ */ React.createElement(SkuGrid, { skus: featuredSkus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku })));
}
function CategoryHero({ category, crumbs, searchQuery }) {
  if (searchQuery) {
    return /* @__PURE__ */ React.createElement("div", { className: "category-hero", style: { height: "160px" } }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: crumbs }), /* @__PURE__ */ React.createElement("h1", null, 'Search: "' + searchQuery + '"'));
  }
  const bgImage = category ? (category.banner_image || category.image_url) : null;
  const style = bgImage ? { backgroundImage: "url(" + bgImage + ")" } : {};
  return /* @__PURE__ */ React.createElement("div", { className: "category-hero", style }, /* @__PURE__ */ React.createElement(Breadcrumbs, { items: crumbs }), /* @__PURE__ */ React.createElement("h1", null, category ? category.name : "Shop All"), category && category.description && /* @__PURE__ */ React.createElement("p", null, category.description));
}
function BrowseView({ skus, totalSkus, loading, categories, selectedCategory, selectedCollection, searchQuery, onCategorySelect, facets, filters, onFilterToggle, onClearFilters, sortBy, onSortChange, onSkuClick, currentPage, onPageChange, wishlist, toggleWishlist, setQuickViewSku, filterDrawerOpen, setFilterDrawerOpen, goHome }) {
  const totalPages = Math.ceil(totalSkus / 72);
  const hasFilters = Object.keys(filters).length > 0;
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
  const isParentLanding = currentCategory && !currentCategory.parent_id && !searchQuery && !selectedCollection;
  const landingChildren = isParentLanding ? (currentCategory.children || []).filter((ch) => ch.product_count > 0) : [];
  if (isParentLanding && landingChildren.length > 0) {
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery }), /* @__PURE__ */ React.createElement("section", { className: "category-landing" }, /* @__PURE__ */ React.createElement("h2", null, "Browse ", currentCategory.name), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our ", currentCategory.name.toLowerCase(), " collections"), /* @__PURE__ */ React.createElement("div", { className: "category-landing-grid" }, landingChildren.map(function(child) { return /* @__PURE__ */ React.createElement("div", { key: child.slug, className: "category-tile", onClick: function() { onCategorySelect(child.slug); } }, child.image_url ? /* @__PURE__ */ React.createElement("img", { src: child.image_url, alt: child.name, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-200)" } }), /* @__PURE__ */ React.createElement("div", { className: "category-tile-overlay" }, /* @__PURE__ */ React.createElement("span", { className: "category-tile-name" }, child.name), /* @__PURE__ */ React.createElement("span", { className: "category-tile-count" }, child.product_count + " products"))); }))));
  }
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CategoryHero, { category: currentCategory, crumbs, searchQuery }), /* @__PURE__ */ React.createElement("div", { className: "browse-layout" }, /* @__PURE__ */ React.createElement("div", { className: "sidebar" }, /* @__PURE__ */ React.createElement(FacetPanel, { facets, filters, onFilterToggle, onClearFilters })), /* @__PURE__ */ React.createElement("div", null, hasFilters && /* @__PURE__ */ React.createElement(ActiveFilterPills, { filters, facets, onFilterToggle, onClearFilters }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement(BrowseToolbar, { totalSkus, sortBy, onSortChange }), /* @__PURE__ */ React.createElement("button", { className: "mobile-filter-btn", onClick: () => setFilterDrawerOpen(true) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 16, height: 16 } }, /* @__PURE__ */ React.createElement("line", { x1: "4", y1: "6", x2: "20", y2: "6" }), /* @__PURE__ */ React.createElement("line", { x1: "8", y1: "12", x2: "20", y2: "12" }), /* @__PURE__ */ React.createElement("line", { x1: "12", y1: "18", x2: "20", y2: "18" })), "Filters")), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 8 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "1.125rem", marginBottom: "1rem" } }, "No products found"), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.875rem" } }, "Try adjusting your filters or search terms")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(SkuGrid, { skus, onSkuClick, wishlist, toggleWishlist, setQuickViewSku }), totalPages > 1 && /* @__PURE__ */ React.createElement(Pagination, { currentPage, totalPages, onPageChange })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-overlay" + (filterDrawerOpen ? " open" : ""), onClick: () => setFilterDrawerOpen(false) }), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer" + (filterDrawerOpen ? " open" : "") }, /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-head" }, /* @__PURE__ */ React.createElement("h3", null, "Filters"), /* @__PURE__ */ React.createElement("button", { className: "cart-drawer-close", onClick: () => setFilterDrawerOpen(false) }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-body" }, /* @__PURE__ */ React.createElement(FacetPanel, { facets, filters, onFilterToggle, onClearFilters })), /* @__PURE__ */ React.createElement("div", { className: "filter-drawer-footer" }, /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%" }, onClick: () => setFilterDrawerOpen(false) }, "Apply Filters"))))));
}
function CategoryNav({ categories, selectedCategory, onCategorySelect }) {
  var activeParent = null;
  if (selectedCategory) {
    activeParent = categories.find(function(c) { return c.slug === selectedCategory; });
    if (!activeParent) {
      categories.forEach(function(p) {
        if ((p.children || []).some(function(ch) { return ch.slug === selectedCategory; })) activeParent = p;
      });
    }
  }
  if (!activeParent || !(activeParent.children || []).length) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "category-sidebar" }, /* @__PURE__ */ React.createElement("h3", null, activeParent.name), /* @__PURE__ */ React.createElement("div", { className: "category-item" + (selectedCategory === activeParent.slug ? " active" : ""), onClick: () => onCategorySelect(activeParent.slug) }, /* @__PURE__ */ React.createElement("span", null, "All ", activeParent.name), /* @__PURE__ */ React.createElement("span", { className: "category-count" }, activeParent.product_count)), (activeParent.children || []).map((child) => /* @__PURE__ */ React.createElement("div", { key: child.slug, className: "category-item" + (selectedCategory === child.slug ? " active" : ""), onClick: () => onCategorySelect(child.slug) }, /* @__PURE__ */ React.createElement("span", null, child.name), /* @__PURE__ */ React.createElement("span", { className: "category-count" }, child.product_count))));
}
function FacetPanel({ facets, filters, onFilterToggle, onClearFilters }) {
  const hasActive = Object.keys(filters).length > 0;
  const [collapsed, setCollapsed] = useState(null);
  const [showAll, setShowAll] = useState({});
  var hiddenFacets = ["pei_rating", "water_absorption", "dcof"];
  var visibleFacets = facets.filter(function(g) { return hiddenFacets.indexOf(g.slug) === -1; });
  if (!visibleFacets || visibleFacets.length === 0) return null;
  if (collapsed === null) {
    var init = {};
    visibleFacets.forEach(function(g) { init[g.slug] = true; });
    setCollapsed(init);
    return null;
  }
  const chevron = function(isOpen) {
    return /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", style: { width: 14, height: 14, transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" } }, /* @__PURE__ */ React.createElement("polyline", { points: "6 9 12 15 18 9" }));
  };
  return /* @__PURE__ */ React.createElement("div", { className: "filter-panel" }, hasActive && /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: "0.75rem", borderBottom: "1px solid var(--stone-200)", marginBottom: "0.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--stone-900)" } }, "Filters"), /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear All")), visibleFacets.map((group) => {
    const isCollapsed = collapsed[group.slug];
    const showAllValues = showAll[group.slug];
    const values = showAllValues ? group.values : group.values.slice(0, 8);
    return /* @__PURE__ */ React.createElement("div", { key: group.slug, className: "filter-group" }, /* @__PURE__ */ React.createElement("div", { className: "filter-group-title", onClick: () => setCollapsed((prev) => ({ ...prev, [group.slug]: !prev[group.slug] })) }, /* @__PURE__ */ React.createElement("span", null, group.name), chevron(!isCollapsed)), !isCollapsed && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.625rem" } }, values.map((v) => {
      const checked = (filters[group.slug] || []).includes(v.value);
      return /* @__PURE__ */ React.createElement("div", { key: v.value, className: "filter-option" }, /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "checkbox",
          id: "f-" + group.slug + "-" + v.value,
          checked,
          onChange: () => onFilterToggle(group.slug, v.value)
        }
      ), /* @__PURE__ */ React.createElement("label", { htmlFor: "f-" + group.slug + "-" + v.value }, v.value), /* @__PURE__ */ React.createElement("span", { className: "filter-count" }, "(", v.count, ")"));
    }), group.values.length > 8 && !showAllValues && /* @__PURE__ */ React.createElement("button", { className: "show-more-btn", onClick: () => setShowAll((prev) => ({ ...prev, [group.slug]: true })) }, "+ ", group.values.length - 8, " more")));
  }));
}
function ActiveFilterPills({ filters, facets, onFilterToggle, onClearFilters }) {
  const pills = [];
  Object.keys(filters).forEach((slug) => {
    const group = facets.find((f) => f.slug === slug);
    const name = group ? group.name : slug;
    (filters[slug] || []).forEach((val) => {
      pills.push({ slug, name, value: val });
    });
  });
  if (pills.length === 0) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "active-filters" }, pills.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "filter-pill" }, /* @__PURE__ */ React.createElement("span", null, p.name, ": ", p.value), /* @__PURE__ */ React.createElement("button", { onClick: () => onFilterToggle(p.slug, p.value) }, "\xD7"))), /* @__PURE__ */ React.createElement("button", { className: "filter-clear", onClick: onClearFilters }, "Clear All"));
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
      onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection),
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
  const price = sku.trade_price || sku.retail_price;
  return /* @__PURE__ */ React.createElement("div", { className: "sku-card", onClick }, /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "wishlist-heart" + (isWished ? " active" : ""),
      onClick: (e) => {
        e.stopPropagation();
        onToggleWishlist();
      }
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: isWished ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" }))
  ), /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, sku.primary_image && /* @__PURE__ */ React.createElement("img", { src: sku.primary_image, alt: sku.product_name, loading: "lazy", decoding: "async", width: "300", height: "300" }), sku.alternate_image && /* @__PURE__ */ React.createElement("img", { className: "sku-card-alt-img", src: sku.alternate_image, alt: "", loading: "lazy", decoding: "async", width: "300", height: "300" }), onQuickView && /* @__PURE__ */ React.createElement("button", { className: "quick-view-btn", onClick: (e) => {
    e.stopPropagation();
    onQuickView();
  } }, "Quick View")), /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, sku.collection && sku.collection.toLowerCase() !== (sku.product_name || "").toLowerCase() ? `${sku.collection} ${sku.product_name}` : sku.product_name || sku.collection), sku.variant_count > 1 ? /* @__PURE__ */ React.createElement("div", { className: "sku-card-variant" }, sku.variant_count, " options") : sku.variant_name && /* @__PURE__ */ React.createElement("div", { className: "sku-card-variant" }, formatVariantName(sku.variant_name)), /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, price ? /* @__PURE__ */ React.createElement(React.Fragment, null, sku.trade_price && sku.retail_price && /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "0.875rem", marginRight: "0.5rem" } }, "$", parseFloat(sku.retail_price).toFixed(2)), "$", parseFloat(price).toFixed(2), /* @__PURE__ */ React.createElement("span", { className: "price-suffix" }, priceSuffix(sku))) : "Contact for pricing"));
}
function SkuDetailView({ skuId, goBack, addToCart, cart, onSkuClick, onRequestInstall, tradeCustomer, wishlist, toggleWishlist, recentlyViewed, addRecentlyViewed, customer, customerToken, onShowAuth, showToast, categories }) {
  const [sku, setSku] = useState(null);
  const [media, setMedia] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const [collectionSiblings, setCollectionSiblings] = useState([]);
  const [collectionAttributes, setCollectionAttributes] = useState({});
  const [groupedProducts, setGroupedProducts] = useState([]);
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
      setCollectionSiblings(data.collection_siblings || []);
      setCollectionAttributes(data.collection_attributes || {});
      setGroupedProducts(data.grouped_products || []);
      setLoading(false);
      if (data.sku && addRecentlyViewed) {
        addRecentlyViewed({ sku_id: data.sku.sku_id, product_name: data.sku.product_name, variant_name: data.sku.variant_name, primary_image: data.media && data.media[0] ? data.media[0].url : null, retail_price: data.sku.retail_price, price_basis: data.sku.price_basis });
      }
      if (data.sku) {
        const skuTitle = data.sku.product_name + (data.sku.variant_name ? " - " + formatVariantName(data.sku.variant_name) : "") + " | Roma Flooring Designs";
        const skuDesc = cleanDescription(data.sku.description_short, data.sku.vendor_name) || "Premium " + data.sku.product_name + " from Roma Flooring Designs";
        const skuImage = data.media && data.media[0] ? data.media[0].url : null;
        updateSEO({ title: skuTitle, description: skuDesc, url: SITE_URL + "/shop/sku/" + skuId, image: skuImage });
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
  }, [skuId]);
  useEffect(() => {
    if (!sku) return;
    const skuDesc = cleanDescription(sku.description_short, sku.vendor_name) || "Premium " + sku.product_name + " from Roma Flooring Designs";
    const skuImage = media && media[0] ? media[0].url : null;
    const product = {
      "@type": "Product",
      name: sku.product_name,
      description: skuDesc,
      image: skuImage,
      sku: sku.sku_code || String(sku.sku_id),
      mpn: sku.sku_code || "",
      brand: { "@type": "Brand", name: sku.vendor_name || "Roma Flooring Designs" },
      category: sku.category_name || "",
      offers: {
        "@type": "Offer",
        url: SITE_URL + "/shop/sku/" + skuId,
        priceCurrency: "USD",
        price: parseFloat(sku.retail_price || 0).toFixed(2),
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
  const retailPrice = sku ? parseFloat(sku.retail_price) || 0 : 0;
  const tradePrice = sku && sku.trade_price ? parseFloat(sku.trade_price) : null;
  const isCarpetSku = sku && isCarpet(sku);
  const cutPrice = isCarpetSku ? parseFloat(sku.cut_price) : 0;
  const rollPrice = isCarpetSku ? parseFloat(sku.roll_price) : 0;
  const rollMinSqft = isCarpetSku && sku.roll_min_sqft ? parseFloat(sku.roll_min_sqft) : 0;
  const rollWidthFt = isCarpetSku && sku.roll_width_ft ? parseFloat(sku.roll_width_ft) : 0;
  const effectiveCarpetMode = carpetInputMode === "linear" && rollWidthFt <= 0 ? "dimensions" : carpetInputMode;
  const carpetSqft = isCarpetSku ? effectiveCarpetMode === "linear" ? rollWidthFt * (parseFloat(linearFeet) || 0) : effectiveCarpetMode === "dimensions" ? (parseFloat(roomWidth) || 0) * (parseFloat(roomLength) || 0) : parseFloat(sqftInput) || 0 : 0;
  const carpetPriceTier = isCarpetSku && rollMinSqft > 0 && carpetSqft >= rollMinSqft ? "roll" : "cut";
  const carpetActivePrice = isCarpetSku ? carpetPriceTier === "roll" ? rollPrice : cutPrice : 0;
  const carpetSubtotal = carpetSqft * carpetActivePrice;
  const carpetSqftToRoll = isCarpetSku && rollMinSqft > 0 && carpetSqft > 0 && carpetSqft < rollMinSqft ? rollMinSqft - carpetSqft : 0;
  const carpetRollSavings = isCarpetSku && carpetSqftToRoll > 0 ? ((cutPrice - rollPrice) * rollMinSqft).toFixed(2) : "0";
  const effectivePrice = isCarpetSku ? carpetActivePrice : tradePrice || retailPrice;
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
  const hasBoxCalc = !isPerUnit && sqftPerBox > 0;
  const isSqftNoBox = !isPerUnit && sqftPerBox <= 0;
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
        sell_by: "sqft",
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
  } }, /* @__PURE__ */ React.createElement("input", { type: "text", placeholder: "Search for products...", value: notFoundSearch, onChange: (e) => setNotFoundSearch(e.target.value) }), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn" }, "Search")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: goBack, style: { marginTop: "1rem" } }, "Back to Shop")), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, rv.primary_image && /* @__PURE__ */ React.createElement("img", { src: rv.primary_image, alt: rv.product_name, loading: "lazy" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, rv.product_name), rv.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", parseFloat(rv.retail_price).toFixed(2), rv.price_basis === "per_unit" ? "/ea" : "/sqft"))))), fetchError === "not_found" && categories && categories.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2.5rem" } }, /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem" } }, "Popular Categories"), /* @__PURE__ */ React.createElement("div", { className: "not-found-cats" }, categories.slice(0, 8).map((cat) => /* @__PURE__ */ React.createElement("a", { key: cat.slug, className: "not-found-cat-link", onClick: () => {
    goBack();
  } }, cat.name)))));
  if (loading) return /* @__PURE__ */ React.createElement("div", { className: "sku-detail", style: { minHeight: "80vh" } }, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 12, background: "var(--stone-100)", borderRadius: 2 } }), /* @__PURE__ */ React.createElement("div", { style: { width: 80, height: 12, background: "var(--stone-100)", borderRadius: 2 } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery" }, /* @__PURE__ */ React.createElement("div", { style: { width: "100%", paddingBottom: "100%", background: "var(--stone-100)", animation: "pulse 1.5s ease-in-out infinite" } })), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info" }, /* @__PURE__ */ React.createElement("div", { style: { width: "40%", height: 16, background: "var(--stone-100)", borderRadius: 2, marginBottom: "1rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "70%", height: 32, background: "var(--stone-100)", borderRadius: 2, marginBottom: "0.75rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "50%", height: 14, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "30%", height: 28, background: "var(--stone-100)", borderRadius: 2, marginBottom: "2rem" } }), /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: 200, background: "var(--stone-50)", borderRadius: 2 } }))));
  if (!sku) return /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "6rem", color: "var(--stone-600)" } }, "SKU not found");
  const images = media.filter((m) => m.asset_type !== "spec_pdf");
  const specPdfs = media.filter((m) => m.asset_type === "spec_pdf");
  const mainImage = images[selectedImage] || images[0];
  const mainSiblings = siblings.filter((s) => s.variant_type !== "accessory");
  const accessorySiblings = siblings.filter((s) => s.variant_type === "accessory");
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sku-detail" }, /* @__PURE__ */ React.createElement("div", { className: "breadcrumbs" }, /* @__PURE__ */ React.createElement("a", { onClick: goBack }, "Shop"), /* @__PURE__ */ React.createElement("span", null, "/"), sku.category_name && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("a", { onClick: goBack }, sku.category_name), /* @__PURE__ */ React.createElement("span", null, "/")), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-800)" } }, sku.product_name, sku.variant_name ? " \u2014 " + formatVariantName(sku.variant_name) : "")), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-main" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-gallery" }, /* @__PURE__ */ React.createElement("div", { className: "sku-detail-image" }, mainImage && /* @__PURE__ */ React.createElement("img", { src: mainImage.url, alt: sku.product_name, decoding: "async" })), images.length > 1 && /* @__PURE__ */ React.createElement("div", { className: "gallery-thumbs" }, images.map((img, i) => /* @__PURE__ */ React.createElement("div", { key: img.id, className: "gallery-thumb" + (i === selectedImage ? " active" : ""), onClick: () => setSelectedImage(i) }, /* @__PURE__ */ React.createElement("img", { src: img.url, alt: "", loading: "lazy", decoding: "async", width: "80", height: "80" }))))), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-info" }, /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goBack }, "\u2190 Back to Shop"), /* @__PURE__ */ React.createElement("h1", null, sku.collection && sku.collection.toLowerCase() !== sku.product_name.toLowerCase() ? `${sku.collection} ${sku.product_name}` : sku.product_name), sku.variant_name && /* @__PURE__ */ React.createElement("div", { className: "sku-detail-variant" }, formatVariantName(sku.variant_name)), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-meta" }, sku.vendor_name), /* @__PURE__ */ React.createElement("div", { className: "sku-detail-price" }, isCarpet(sku) ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "1.75rem", fontWeight: 600 } }, "$", parseFloat(sku.cut_price).toFixed(2)), /* @__PURE__ */ React.createElement("span", null, "/sqft"), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--stone-500)", fontSize: "0.9375rem", marginLeft: "0.5rem" } }, "($", carpetSqydPrice(sku.cut_price), "/sqyd)")), sku.roll_price && parseFloat(sku.roll_price) < parseFloat(sku.cut_price) && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.875rem", color: "var(--sage)", marginTop: "0.375rem" } }, "Roll Price: $", parseFloat(sku.roll_price).toFixed(2), "/sqft ($", carpetSqydPrice(sku.roll_price), "/sqyd)", sku.roll_min_sqft && /* @__PURE__ */ React.createElement("span", null, " \u2014 orders over ", parseFloat(sku.roll_min_sqft).toFixed(0), " sqft")), tradePrice && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--gold)", marginTop: "0.25rem" } }, "Trade Price (", sku.trade_tier, ")")) : tradePrice ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { textDecoration: "line-through", color: "var(--stone-500)", fontSize: "1.25rem", marginRight: "0.5rem" } }, "$", retailPrice.toFixed(2)), "$", tradePrice.toFixed(2), /* @__PURE__ */ React.createElement("span", null, priceSuffix(sku)), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--gold)", marginTop: "0.25rem" } }, "Trade Price (", sku.trade_tier, ")")) : retailPrice > 0 ? /* @__PURE__ */ React.createElement(React.Fragment, null, "$", retailPrice.toFixed(2), /* @__PURE__ */ React.createElement("span", null, priceSuffix(sku))) : "Contact for pricing"), (() => {
    const currentAttrs = (sku.attributes || []).reduce((m, a) => {
      m[a.slug] = a.value;
      return m;
    }, {});
    const allSiblings = [{ sku_id: sku.sku_id, variant_name: sku.variant_name, attributes: sku.attributes || [], primary_image: media && media[0] ? media[0].url : null }, ...mainSiblings];
    const colorItems = collectionSiblings.length > 0 ? [
      { sku_id: sku.sku_id, product_name: sku.product_name, primary_image: media && media[0] ? media[0].url : null, is_current: true },
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
    const NON_SELECTABLE = /* @__PURE__ */ new Set(["pei_rating", "shade_variation", "water_absorption", "dcof", "material", "country", "application", "edge", "look", "color"]);
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
    const showAttrs = attrSlugs.length > 0;
    if (!showColors && !showAttrs) return null;
    return /* @__PURE__ */ React.createElement("div", { className: "variant-selectors" }, showColors && /* @__PURE__ */ React.createElement("div", { className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, "Color", /* @__PURE__ */ React.createElement("span", null, sku.product_name)), /* @__PURE__ */ React.createElement("div", { className: "color-swatches" }, colorItems.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.sku_id, className: "color-swatch" + (c.is_current ? " active" : ""), onClick: () => {
      if (!c.is_current) onSkuClick(c.sku_id);
    } }, c.primary_image ? /* @__PURE__ */ React.createElement("img", { src: c.primary_image, alt: c.product_name, loading: "lazy", decoding: "async", width: "48", height: "48" }) : /* @__PURE__ */ React.createElement("div", { style: { width: "100%", height: "100%", background: "var(--stone-100)" } }), /* @__PURE__ */ React.createElement("div", { className: "color-swatch-tooltip" }, c.product_name))))), showAttrs && attrSlugs.map((slug) => {
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
        const desired = { ...currentAttrs, [slug]: val };
        const scored = allSiblings.filter((s) => s.sku_id !== sku.sku_id).map((s) => {
          const sa = (s.attributes || []).reduce((m, a) => {
            m[a.slug] = a.value;
            return m;
          }, {});
          let score = 0;
          Object.keys(desired).forEach((k) => {
            if (sa[k] === desired[k]) score++;
          });
          return { ...s, score };
        });
        return scored.sort((a, b) => b.score - a.score)[0];
      };
      return /* @__PURE__ */ React.createElement("div", { key: slug, className: "variant-selector-group" }, /* @__PURE__ */ React.createElement("div", { className: "variant-selector-label" }, attrMap[slug].name, /* @__PURE__ */ React.createElement("span", null, currentVal || "")), values.length > 8 ? /* @__PURE__ */ React.createElement("select", { className: "attr-select", value: currentVal || "", onChange: (e) => {
        const best = findBest(e.target.value);
        if (best) onSkuClick(best.sku_id);
      } }, values.map((val) => /* @__PURE__ */ React.createElement("option", { key: val, value: val }, val))) : /* @__PURE__ */ React.createElement("div", { className: "attr-pills" }, values.map((val) => {
        const isActive = val === currentVal;
        const best = findBest(val);
        return /* @__PURE__ */ React.createElement("button", { key: val, className: "attr-pill" + (isActive ? " active" : ""), onClick: () => {
          if (!isActive && best) onSkuClick(best.sku_id);
        } }, val);
      })));
    }));
  })(), /* @__PURE__ */ React.createElement(StockBadge, { status: sku.stock_status, vendorHasInventory: sku.vendor_has_inventory }), sku.stock_status === "out_of_stock" && sku.vendor_has_inventory !== false && /* @__PURE__ */ React.createElement("div", { className: "stock-alert-box" }, alertSuccess || alertSubscribed ? /* @__PURE__ */ React.createElement("div", { className: "stock-alert-success" }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "#166534", strokeWidth: "2" }, /* @__PURE__ */ React.createElement("path", { d: "M20 6L9 17l-5-5" })), "We'll notify you when this item is back in stock") : customer ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading }, alertLoading ? "Subscribing..." : "Notify Me When Available")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("p", null, "Get notified when this item is back in stock"), /* @__PURE__ */ React.createElement("div", { className: "stock-alert-form" }, /* @__PURE__ */ React.createElement("input", { type: "email", placeholder: "Enter your email", value: alertEmail, onChange: (e) => setAlertEmail(e.target.value) }), /* @__PURE__ */ React.createElement("button", { className: "stock-alert-btn", onClick: handleStockAlertSubmit, disabled: alertLoading || !alertEmail }, alertLoading ? "Subscribing..." : "Notify Me")))), accessorySiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "accessories-section-sf" }, /* @__PURE__ */ React.createElement("h3", null, "Matching Accessories"), /* @__PURE__ */ React.createElement("p", { className: "accessories-subtitle-sf" }, "Complete your installation with coordinating trim and transitions"), accessorySiblings.map((acc) => {
    const accPrice = parseFloat(acc.retail_price) || 0;
    const accQty = accessoryQtys[acc.sku_id] || 1;
    return /* @__PURE__ */ React.createElement("div", { key: acc.sku_id, className: "accessory-card-sf" }, /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-header" }, /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-name" }, formatVariantName(acc.variant_name) || "Accessory"), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-price" }, "$", accPrice.toFixed(2), " /ea")), /* @__PURE__ */ React.createElement("div", { className: "accessory-card-sf-actions" }, /* @__PURE__ */ React.createElement("div", { className: "unit-qty-stepper" }, /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: Math.max(1, (prev[acc.sku_id] || 1) - 1) })) }, "\u2212"), /* @__PURE__ */ React.createElement("input", { type: "number", min: "1", value: accQty, onChange: (e) => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: Math.max(1, parseInt(e.target.value) || 1) })) }), /* @__PURE__ */ React.createElement("button", { onClick: () => setAccessoryQtys((prev) => ({ ...prev, [acc.sku_id]: (prev[acc.sku_id] || 1) + 1 })) }, "+")), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { padding: "0.6rem 1.5rem", fontSize: "0.8125rem" }, onClick: () => {
      addToCart({
        product_id: sku.product_id,
        sku_id: acc.sku_id,
        sqft_needed: 0,
        num_boxes: accQty,
        include_overage: false,
        unit_price: accPrice,
        subtotal: (accQty * accPrice).toFixed(2),
        sell_by: "unit"
      });
    } }, "Add \u2014 $", (accQty * accPrice).toFixed(2))));
  })), sqftPerBox > 0 && /* @__PURE__ */ React.createElement("div", { className: "packaging-info" }, /* @__PURE__ */ React.createElement("h4", null, "Packaging Details"), /* @__PURE__ */ React.createElement("div", null, "Coverage: ", sqftPerBox, " sqft/box"), sku.pieces_per_box && /* @__PURE__ */ React.createElement("div", null, "Pieces: ", sku.pieces_per_box, "/box"), sku.weight_per_box_lbs && /* @__PURE__ */ React.createElement("div", null, "Weight: ", parseFloat(sku.weight_per_box_lbs).toFixed(1), " lbs/box"), sku.boxes_per_pallet && /* @__PURE__ */ React.createElement("div", null, "Pallet: ", sku.boxes_per_pallet, " boxes (", parseFloat(sku.sqft_per_pallet || 0).toFixed(0), " sqft)")), isCarpetSku && cutPrice > 0 && /* @__PURE__ */ React.createElement("div", { className: "calculator-widget" }, /* @__PURE__ */ React.createElement("h3", null, "Carpet Calculator"), rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem", padding: "0.5rem 0.75rem", background: "var(--stone-50)", borderRadius: "0.375rem", fontSize: "0.875rem" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "var(--stone-500)", strokeWidth: "1.5", style: { width: 16, height: 16, flexShrink: 0 } }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "9", x2: "21", y2: "9" })), /* @__PURE__ */ React.createElement("span", null, "Roll Width: ", /* @__PURE__ */ React.createElement("strong", null, rollWidthFt, " ft"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0.375rem", marginBottom: "1rem" } }, rollWidthFt > 0 && /* @__PURE__ */ React.createElement(
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
  ))) : carpetInputMode === "dimensions" ? /* @__PURE__ */ React.createElement("div", { className: "calc-input-row" }, /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Width (ft)"), /* @__PURE__ */ React.createElement(
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
  )), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", padding: "0 0.25rem 0.5rem", fontSize: "1.25rem", color: "var(--stone-400)" } }, "\xD7"), /* @__PURE__ */ React.createElement("div", { className: "calc-input-group" }, /* @__PURE__ */ React.createElement("label", null, "Length (ft)"), /* @__PURE__ */ React.createElement(
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
  ))), carpetSqft > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary" }, carpetInputMode === "linear" && rollWidthFt > 0 && /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Cut"), /* @__PURE__ */ React.createElement("span", null, rollWidthFt, " ft \xD7 ", parseFloat(linearFeet).toFixed(1), " ft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Area"), /* @__PURE__ */ React.createElement("span", null, carpetSqft.toFixed(1), " sqft (", (carpetSqft / 9).toFixed(1), " sqyd)")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Price Tier"), /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "0.375rem" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.125rem 0.5rem", borderRadius: "0.25rem", fontSize: "0.75rem", fontWeight: 600, background: carpetPriceTier === "roll" ? "var(--sage)" : "var(--stone-200)", color: carpetPriceTier === "roll" ? "white" : "var(--stone-700)" } }, carpetPriceTier === "roll" ? "Roll Price" : "Cut Price"), "$", carpetActivePrice.toFixed(2), "/sqft")), /* @__PURE__ */ React.createElement("div", { className: "calc-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", carpetSubtotal.toFixed(2)))), carpetSqftToRoll > 0 && parseFloat(carpetRollSavings) > 0 && /* @__PURE__ */ React.createElement("div", { style: { background: "var(--sage-bg, #f0f7f4)", border: "1px solid var(--sage, #6b9080)", borderRadius: "0.375rem", padding: "0.625rem 0.75rem", fontSize: "0.8125rem", color: "var(--sage, #6b9080)", marginTop: "0.5rem" } }, "Add ", carpetSqftToRoll.toFixed(0), " more sqft for roll pricing \u2014 save $", carpetRollSavings), /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn",
      style: { width: "100%", marginTop: "1.5rem" },
      onClick: handleAddToCart,
      disabled: carpetSqft <= 0
    },
    "Add to Cart ",
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
    "Add to Cart ",
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
    "Add to Cart ",
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
    effectivePrice > 0 ? `Add to Cart \u2014 $${unitSubtotal.toFixed(2)}` : "Add to Cart"
  )), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", style: { width: "100%", marginBottom: "1rem" }, onClick: handleRequestSample }, "Request Free Sample"), sku && /* @__PURE__ */ React.createElement(
    "button",
    {
      className: "btn btn-secondary",
      style: { width: "100%", marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" },
      onClick: () => toggleWishlist(sku.product_id)
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: wishlist.includes(sku.product_id) ? "currentColor" : "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 18, height: 18, color: wishlist.includes(sku.product_id) ? "#e11d48" : "currentColor" } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })),
    wishlist.includes(sku.product_id) ? "Saved to Wishlist" : "Add to Wishlist"
  ), /* @__PURE__ */ React.createElement("div", { className: "install-cta" }, /* @__PURE__ */ React.createElement("p", null, "Need professional installation?"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-secondary", onClick: () => onRequestInstall(sku) }, "Request Installation Quote")), sku.attributes && sku.attributes.length > 0 && /* @__PURE__ */ React.createElement("table", { className: "specs-table" }, /* @__PURE__ */ React.createElement("tbody", null, sku.attributes.map((a, i) => /* @__PURE__ */ React.createElement("tr", { key: i }, /* @__PURE__ */ React.createElement("td", null, a.name), /* @__PURE__ */ React.createElement("td", null, a.value))))), (sku.description_long || sku.description_short) && (() => {
    const cleaned = cleanDescription(sku.description_long || sku.description_short, sku.vendor_name);
    return cleaned ? /* @__PURE__ */ React.createElement("div", { style: { marginTop: "2rem", fontSize: "0.9rem", lineHeight: 1.7, color: "var(--stone-600)" } }, cleaned) : null;
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
  ))))), groupedProducts.length > 0 && (() => {
    const byCategory = {};
    groupedProducts.forEach((gp) => {
      const cat = gp.category_name || "Related";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(gp);
    });
    return /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Complete the Look"), Object.entries(byCategory).map(([catName, items]) => /* @__PURE__ */ React.createElement("div", { key: catName, style: { marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--stone-500)", marginBottom: "0.75rem" } }, catName), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, items.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { src: s.primary_image, alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, s.product_name), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "from $", parseFloat(s.retail_price).toFixed(2), s.sell_by === "sqft" ? "/sf" : s.price_basis === "per_sqft" ? "/sf" : "")))))));
  })(), mainSiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Other Sizes & Finishes"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, mainSiblings.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { src: s.primary_image, alt: formatVariantName(s.variant_name), loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, formatVariantName(s.variant_name) || "Variant"), s.attributes && s.attributes.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta" }, s.attributes.map((a) => a.value).join(" \xB7 ")), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", parseFloat(s.retail_price).toFixed(2), priceSuffix(s)))))), collectionSiblings.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "More from ", sku.collection), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, collectionSiblings.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { src: s.primary_image, alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, s.product_name), s.variant_name && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta" }, formatVariantName(s.variant_name)), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", parseFloat(s.retail_price).toFixed(2)))))), recentlyViewed && recentlyViewed.filter((r) => r.sku_id !== skuId).length > 0 && /* @__PURE__ */ React.createElement("div", { className: "siblings-section" }, /* @__PURE__ */ React.createElement("h2", null, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.filter((r) => r.sku_id !== skuId).slice(0, 8).map((s) => /* @__PURE__ */ React.createElement("div", { key: s.sku_id, className: "sibling-card", onClick: () => onSkuClick(s.sku_id) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, s.primary_image && /* @__PURE__ */ React.createElement("img", { src: s.primary_image, alt: s.product_name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, s.product_name), s.variant_name && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-meta" }, formatVariantName(s.variant_name)), s.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", parseFloat(s.retail_price).toFixed(2), s.price_basis === "per_sqft" ? "/sf" : ""))))), /* @__PURE__ */ React.createElement("div", { className: "reviews-section" }, /* @__PURE__ */ React.createElement("h2", null, "Customer Reviews"), reviewCount > 0 && /* @__PURE__ */ React.createElement("div", { className: "reviews-summary" }, /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-rating" }, avgRating.toFixed(1)), /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-stars" }, /* @__PURE__ */ React.createElement(StarDisplay, { rating: avgRating, size: 20 })), /* @__PURE__ */ React.createElement("div", { className: "reviews-summary-count" }, reviewCount, " review", reviewCount !== 1 ? "s" : "")), reviews.length > 0 ? reviews.map((r) => /* @__PURE__ */ React.createElement("div", { key: r.id, className: "review-card" }, /* @__PURE__ */ React.createElement("div", { className: "review-card-header" }, /* @__PURE__ */ React.createElement(StarDisplay, { rating: r.rating, size: 14 }), /* @__PURE__ */ React.createElement("span", { className: "review-card-author" }, r.first_name), /* @__PURE__ */ React.createElement("span", { className: "review-card-date" }, new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))), r.title && /* @__PURE__ */ React.createElement("div", { className: "review-card-title" }, r.title), r.body && /* @__PURE__ */ React.createElement("div", { className: "review-card-body" }, r.body))) : /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-400)", fontSize: "0.875rem" } }, "No reviews yet. Be the first to share your experience."), customer ? /* @__PURE__ */ React.createElement("div", { className: "review-form" }, /* @__PURE__ */ React.createElement("h3", null, reviewSubmitted ? "Update Your Review" : "Write a Review"), /* @__PURE__ */ React.createElement("div", { className: "star-picker" }, [1, 2, 3, 4, 5].map((i) => /* @__PURE__ */ React.createElement(
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
  ] }), /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goBrowse }, "\u2190 Continue Shopping"), /* @__PURE__ */ React.createElement("h1", null, "Your Cart"), cart.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem 0", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", { style: { fontSize: "1.125rem", marginBottom: "2rem" } }, "Your cart is empty"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Browse Products")) : /* @__PURE__ */ React.createElement("div", { className: "cart-page-layout" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cart-table" }, /* @__PURE__ */ React.createElement("div", { className: "cart-table-header" }, /* @__PURE__ */ React.createElement("div", null, "Product"), /* @__PURE__ */ React.createElement("div", null, "Quantity"), /* @__PURE__ */ React.createElement("div", null, "Coverage"), /* @__PURE__ */ React.createElement("div", null, "Total"), /* @__PURE__ */ React.createElement("div", null)), cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "cart-table-row" + (item.is_sample ? " sample-item" : "") }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { className: "cart-table-product-name" }, item.product_name || "Product", item.is_sample && /* @__PURE__ */ React.createElement("span", { className: "sample-tag" }, "Sample")), /* @__PURE__ */ React.createElement("div", { className: "cart-table-product-meta" }, item.is_sample ? "Free sample" : /* @__PURE__ */ React.createElement(React.Fragment, null, item.collection && /* @__PURE__ */ React.createElement("span", null, item.collection, " \xB7 "), "$", parseFloat(item.unit_price).toFixed(2), item.sell_by === "unit" ? "/ea" : "/sqft", item.price_tier && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", marginLeft: "0.375rem", padding: "0.0625rem 0.375rem", borderRadius: "0.1875rem", fontSize: "0.6875rem", fontWeight: 600, background: item.price_tier === "roll" ? "var(--sage, #6b9080)" : "var(--stone-200)", color: item.price_tier === "roll" ? "white" : "var(--stone-600)" } }, item.price_tier === "roll" ? "Roll Price" : "Cut Price")))), /* @__PURE__ */ React.createElement("div", null, item.is_sample ? "1" : item.price_tier ? /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, fontSize: "0.875rem" } }, parseFloat(item.sqft_needed || 0).toFixed(0), " sqft") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "cart-qty-controls" }, /* @__PURE__ */ React.createElement("button", { className: "cart-qty-btn", onClick: () => handleQtyChange(item, -1) }, "\u2212"), /* @__PURE__ */ React.createElement("span", { style: { width: 40, textAlign: "center", fontWeight: 500 } }, item.num_boxes), /* @__PURE__ */ React.createElement("button", { className: "cart-qty-btn", onClick: () => handleQtyChange(item, 1) }, "+")), /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "var(--stone-600)", marginTop: "0.25rem" } }, item.sell_by === "unit" ? parseInt(item.num_boxes) !== 1 ? "units" : "unit" : "box" + (parseInt(item.num_boxes) !== 1 ? "es" : "")))), /* @__PURE__ */ React.createElement("div", null, item.is_sample || item.sell_by === "unit" ? "\u2014" : parseFloat(item.sqft_needed || 0).toFixed(1) + " sqft"), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500 } }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { className: "cart-remove-btn", onClick: () => removeFromCart(item.id), title: "Remove" }, /* @__PURE__ */ React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }), /* @__PURE__ */ React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })))))))), /* @__PURE__ */ React.createElement("div", { className: "order-summary" }, /* @__PURE__ */ React.createElement("h3", null, "Order Summary"), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row" }, /* @__PURE__ */ React.createElement("span", null, "Products (", [totalBoxes > 0 && `${totalBoxes} box${totalBoxes !== 1 ? "es" : ""}`, totalUnits > 0 && `${totalUnits} unit${totalUnits !== 1 ? "s" : ""}`].filter(Boolean).join(", "), ")"), /* @__PURE__ */ React.createElement("span", null, "$", productSubtotal.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Samples (", sampleItems.length, ")"), /* @__PURE__ */ React.createElement("span", null, "FREE")), /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Sample Shipping"), /* @__PURE__ */ React.createElement("span", null, "$12.00"))), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid var(--stone-200)" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Delivery Method"), hasPickupOnly && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.75rem", color: "#b45309", background: "#fef3c7", padding: "0.5rem 0.75rem", marginBottom: "0.5rem", borderLeft: "3px solid #f59e0b" } }, "Your cart contains items available for store pickup only."), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem", cursor: hasPickupOnly ? "not-allowed" : "pointer", marginBottom: "0.4rem", opacity: hasPickupOnly ? 0.5 : 1 } }, /* @__PURE__ */ React.createElement(
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
  )), promoError && /* @__PURE__ */ React.createElement("div", { style: { color: "#dc2626", fontSize: "0.75rem", marginTop: "0.3rem" } }, promoError))), /* @__PURE__ */ React.createElement("div", { className: "order-summary-total" }, /* @__PURE__ */ React.createElement("span", null, selectedShippingOption ? "Estimated Total" : "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { width: "100%", marginTop: "1rem" }, onClick: goCheckout }, "Proceed to Checkout"))));
}
function CheckoutPage({ cart, sessionId, goCart, handleOrderComplete, deliveryMethod, tradeCustomer, tradeToken, customer, customerToken, onCustomerLogin, appliedPromoCode, setAppliedPromoCode }) {
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
  const cardRef = useRef(null);
  const cardMounted = useRef(false);
  const isPickup = deliveryMethod === "pickup";
  const productItems = cart.filter((i) => !i.is_sample);
  const sampleItems = cart.filter((i) => i.is_sample);
  const productSubtotal = productItems.reduce((sum, i) => sum + parseFloat(i.subtotal || 0), 0);
  const sampleShipping = sampleItems.length > 0 ? 12 : 0;
  const cartTotal = productSubtotal + sampleShipping;
  const US_STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
  useEffect(() => {
    if (cardMounted.current) return;
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
  }, []);
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!customerName || !customerEmail || !phone || phone.replace(/\D/g, "").length < 10) {
      setError("Please fill in all required fields, including a valid phone number.");
      return;
    }
    if (!isPickup && (!line1 || !city || !state || !zip)) {
      setError("Please fill in all required shipping fields.");
      return;
    }
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
  return /* @__PURE__ */ React.createElement("div", { className: "checkout-page" }, /* @__PURE__ */ React.createElement("h1", null, "Checkout"), /* @__PURE__ */ React.createElement("form", { className: "checkout-form", onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Contact Information"), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Full Name *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: customerName, onChange: (e) => setCustomerName(e.target.value), placeholder: "John Smith" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: customerEmail, onChange: (e) => setCustomerEmail(e.target.value), placeholder: "john@example.com" }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "tel", value: phone, onChange: (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
    let fmt = "";
    if (digits.length > 0) fmt = "(" + digits.slice(0, 3);
    if (digits.length >= 3) fmt += ") ";
    if (digits.length > 3) fmt += digits.slice(3, 6);
    if (digits.length >= 6) fmt += "-" + digits.slice(6);
    setPhone(fmt);
  }, placeholder: "(555) 123-4567" }))), isPickup ? /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Store Pickup"), /* @__PURE__ */ React.createElement("div", { style: { background: "var(--stone-100)", padding: "1.25rem", fontSize: "0.875rem", lineHeight: 1.6 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 500, marginBottom: "0.5rem" } }, "Pickup Location"), /* @__PURE__ */ React.createElement("div", null, "Roma Flooring Designs"), /* @__PURE__ */ React.createElement("div", null, "1440 S. State College Blvd., Suite 6M"), /* @__PURE__ */ React.createElement("div", null, "Anaheim, CA 92806"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "0.75rem", color: "var(--stone-600)", fontSize: "0.8125rem" } }, "Ready for pickup within 5 business days."))) : /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Shipping Address"), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Address Line 1 *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: line1, onChange: (e) => setLine1(e.target.value), placeholder: "123 Main Street" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Address Line 2"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: line2, onChange: (e) => setLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-row-3" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "City *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: city, onChange: (e) => setCity(e.target.value), placeholder: "New York" })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "State *"), /* @__PURE__ */ React.createElement("select", { className: "checkout-input", value: state, onChange: (e) => setState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "ZIP *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: zip, onChange: (e) => setZip(e.target.value), placeholder: "10001" })))), /* @__PURE__ */ React.createElement("div", { className: "checkout-section" }, /* @__PURE__ */ React.createElement("h3", null, "Payment"), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Card Details"), /* @__PURE__ */ React.createElement("div", { id: "card-element", className: "stripe-element" }))), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "checkout-btn", disabled: processing }, processing && /* @__PURE__ */ React.createElement("span", { className: "checkout-spinner" }), processing ? "Processing..." : isPickup ? `Place Order - $${cartTotal.toFixed(2)}` : "Place Order")), /* @__PURE__ */ React.createElement("div", { className: "order-summary" }, /* @__PURE__ */ React.createElement("h3", null, "Order Summary"), cart.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "order-summary-row", style: { fontSize: "0.875rem" } }, /* @__PURE__ */ React.createElement("span", null, item.product_name || "Product", item.is_sample ? " (Sample)" : item.sell_by === "unit" ? ` x ${item.num_boxes}` : ` x ${item.num_boxes} bx`), /* @__PURE__ */ React.createElement("span", null, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal).toFixed(2)))), productItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row", style: { borderTop: "1px solid var(--stone-200)", marginTop: "0.5rem", paddingTop: "0.75rem" } }, /* @__PURE__ */ React.createElement("span", null, "Subtotal"), /* @__PURE__ */ React.createElement("span", null, "$", productSubtotal.toFixed(2))), sampleItems.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "order-summary-row muted" }, /* @__PURE__ */ React.createElement("span", null, "Sample Shipping"), /* @__PURE__ */ React.createElement("span", null, "$12.00")), /* @__PURE__ */ React.createElement("div", { className: "order-summary-total" }, /* @__PURE__ */ React.createElement("span", null, "Total"), /* @__PURE__ */ React.createElement("span", null, "$", cartTotal.toFixed(2))), /* @__PURE__ */ React.createElement("a", { className: "back-btn", onClick: goCart, style: { marginTop: "1rem", display: "inline-block" } }, "\u2190 Back to Cart")));
}
function ConfirmationPage({ order, goBrowse }) {
  if (!order) return null;
  const items = order.items || [];
  return /* @__PURE__ */ React.createElement("div", { className: "confirmation-page" }, /* @__PURE__ */ React.createElement("div", { className: "confirmation-check" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h1", null, "Order Confirmed"), /* @__PURE__ */ React.createElement("div", { className: "confirmation-order-number" }, "Order number: ", /* @__PURE__ */ React.createElement("strong", null, order.order_number)), /* @__PURE__ */ React.createElement("div", { className: "confirmation-details" }, /* @__PURE__ */ React.createElement("h3", null, "Items Ordered"), items.map((item, idx) => /* @__PURE__ */ React.createElement("div", { key: idx, className: "confirmation-item" }, /* @__PURE__ */ React.createElement("span", null, item.product_name || "Product", item.is_sample && " (Sample)", !item.is_sample && (item.sell_by === "unit" ? ` - Qty ${item.num_boxes}` : ` - ${item.num_boxes} box${parseInt(item.num_boxes) !== 1 ? "es" : ""}`)), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 500 } }, item.is_sample ? "FREE" : "$" + parseFloat(item.subtotal || 0).toFixed(2)))), /* @__PURE__ */ React.createElement("div", { className: "confirmation-item", style: { fontWeight: 600 } }, /* @__PURE__ */ React.createElement("span", null, "Total"), /* @__PURE__ */ React.createElement("span", null, "$", parseFloat(order.total || 0).toFixed(2)))), /* @__PURE__ */ React.createElement("button", { className: "btn", style: { marginTop: "2rem" }, onClick: goBrowse }, "Continue Shopping"));
}
function AccountPage({ customer, customerToken, setCustomer, goBrowse }) {
  const [tab, setTab] = useState("orders");
  const [orders, setOrders] = useState([]);
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [orderDetail, setOrderDetail] = useState(null);
  const [loadingOrders, setLoadingOrders] = useState(true);
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
  }, []);
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
      confirmed: { bg: "#dbeafe", text: "#1e40af" },
      shipped: { bg: "#e0e7ff", text: "#3730a3" },
      delivered: { bg: "#dcfce7", text: "#166534" },
      cancelled: { bg: "#fef2f2", text: "#991b1b" }
    };
    const c = colors[status] || colors.pending;
    return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-block", padding: "0.2rem 0.6rem", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", background: c.bg, color: c.text, borderRadius: "3px" } }, status);
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
  return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 900, margin: "3rem auto", padding: "0 1.5rem" } }, /* @__PURE__ */ React.createElement("h1", { style: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: "2rem", fontWeight: 400, marginBottom: "0.5rem" } }, "My Account"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.875rem", marginBottom: "2rem" } }, "Welcome back, ", customer.first_name), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "2rem", borderBottom: "1px solid var(--stone-200)", marginBottom: "2rem" } }, ["orders", "profile"].map((t) => /* @__PURE__ */ React.createElement(
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
        marginBottom: "-1px",
        textTransform: "capitalize"
      }
    },
    t === "orders" ? "Order History" : "Profile"
  ))), tab === "orders" && /* @__PURE__ */ React.createElement("div", null, loadingOrders ? /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", fontSize: "0.875rem" } }, "Loading orders...") : orders.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "3rem 0" } }, /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-500)", marginBottom: "1rem" } }, "No orders yet."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse }, "Start Shopping")) : /* @__PURE__ */ React.createElement("div", null, orders.map((order) => /* @__PURE__ */ React.createElement("div", { key: order.id, style: { border: "1px solid var(--stone-200)", marginBottom: "0.75rem" } }, /* @__PURE__ */ React.createElement(
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
  })(), orderDetail.order.delivery_method !== "pickup" && orderDetail.fulfillment_summary && orderDetail.fulfillment_summary.total > 0 && orderDetail.fulfillment_summary.received > 0 && orderDetail.fulfillment_summary.received < orderDetail.fulfillment_summary.total && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "Your order is being prepared \u2014 ", orderDetail.fulfillment_summary.received, " of ", orderDetail.fulfillment_summary.total, " items received from suppliers"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "0", marginBottom: "1.25rem", fontSize: "0.75rem" } }, ["pending", "confirmed", "shipped", "delivered"].map((s, i) => {
    const steps = ["pending", "confirmed", "shipped", "delivered"];
    const currentIdx = steps.indexOf(orderDetail.order.status);
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
    } }, i + 1), /* @__PURE__ */ React.createElement("span", { style: { color: isActive ? "var(--stone-800)" : "var(--stone-400)", textTransform: "capitalize" } }, s));
  })), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("h4", { style: { fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" } }, "Items"), orderDetail.items.map((item) => {
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
  })), orderDetail.balance && orderDetail.balance.balance_status === "credit" && /* @__PURE__ */ React.createElement("div", { style: { background: "#dbeafe", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#1e40af" } }, "You have a credit of ", /* @__PURE__ */ React.createElement("strong", null, "$", Math.abs(orderDetail.balance.balance).toFixed(2)), " on this order."), orderDetail.balance && orderDetail.balance.balance_status === "balance_due" && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef3c7", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem", color: "#92400e" } }, "Balance due: ", /* @__PURE__ */ React.createElement("strong", null, "$", orderDetail.balance.balance.toFixed(2)), " \u2014 check your email for a payment link."), orderDetail.order.shipping_address_line1 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: "0.8125rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("strong", null, "Ships to:"), " ", orderDetail.order.shipping_address_line1, orderDetail.order.shipping_address_line2 && ", " + orderDetail.order.shipping_address_line2, ", ", orderDetail.order.shipping_city, ", ", orderDetail.order.shipping_state, " ", orderDetail.order.shipping_zip)))))), tab === "profile" && /* @__PURE__ */ React.createElement("div", null, profileMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileMsg), profileError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, profileError), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "First Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: firstName, onChange: (e) => setFirstName(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Last Name"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: lastName, onChange: (e) => setLastName(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Email"), /* @__PURE__ */ React.createElement("input", { style: { ...inputStyle, background: "var(--stone-100)", color: "var(--stone-500)" }, value: customer.email, readOnly: true })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Phone"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "tel", value: phone, onChange: (e) => setPhone(formatPhone(e.target.value)), placeholder: "(555) 123-4567" })), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginTop: "1.5rem", marginBottom: "1rem" } }, "Saved Address"), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 1"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine1, onChange: (e) => setAddressLine1(e.target.value), placeholder: "123 Main Street" })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Address Line 2"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: addressLine2, onChange: (e) => setAddressLine2(e.target.value), placeholder: "Apt, Suite, Unit" })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "City"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: city, onChange: (e) => setCity(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "State"), /* @__PURE__ */ React.createElement("select", { style: { ...inputStyle, padding: "0.65rem 0.5rem" }, value: addrState, onChange: (e) => setAddrState(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Select"), US_STATES.map((s) => /* @__PURE__ */ React.createElement("option", { key: s, value: s }, s)))), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "ZIP"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, value: zip, onChange: (e) => setZip(e.target.value) }))), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: saveProfile, disabled: saving, style: { marginBottom: "2.5rem" } }, saving ? "Saving..." : "Save Changes"), /* @__PURE__ */ React.createElement("h3", { style: { fontSize: "1rem", fontWeight: 500, marginBottom: "1rem", paddingTop: "1.5rem", borderTop: "1px solid var(--stone-200)" } }, "Change Password"), pwMsg && /* @__PURE__ */ React.createElement("div", { style: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwMsg), pwError && /* @__PURE__ */ React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.8125rem" } }, pwError), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Current Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: currentPw, onChange: (e) => setCurrentPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } }, /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: newPw, onChange: (e) => setNewPw(e.target.value) })), /* @__PURE__ */ React.createElement("div", { style: fieldStyle }, /* @__PURE__ */ React.createElement("label", { style: labelStyle }, "Confirm New Password"), /* @__PURE__ */ React.createElement("input", { style: inputStyle, type: "password", value: confirmPw, onChange: (e) => setConfirmPw(e.target.value) }))), /* @__PURE__ */ React.createElement("p", { style: { fontSize: "0.75rem", color: "var(--stone-500)", marginBottom: "1rem" } }, "8+ characters, 1 uppercase letter, 1 number"), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: changePassword, disabled: pwSaving }, pwSaving ? "Updating..." : "Update Password")));
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
  ] }), /* @__PURE__ */ React.createElement("h1", null, "Wishlist ", /* @__PURE__ */ React.createElement("span", { style: { fontSize: "1.25rem", color: "var(--stone-600)", fontWeight: 300 } }, "(", wishlist.length, ")")), loading ? /* @__PURE__ */ React.createElement(SkeletonGrid, { count: 4 }) : skus.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "wishlist-empty" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", style: { width: 56, height: 56, color: "var(--stone-300)", marginBottom: "1rem" } }, /* @__PURE__ */ React.createElement("path", { d: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" })), /* @__PURE__ */ React.createElement("h2", { style: { fontFamily: "var(--font-heading)", fontSize: "1.75rem", fontWeight: 300, marginBottom: "0.5rem" } }, "Your Wishlist is Empty"), /* @__PURE__ */ React.createElement("p", null, "Save your favorite products by clicking the heart icon while you browse."), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: goBrowse, style: { marginTop: "0.5rem" } }, "Browse Products"), recentlyViewed && recentlyViewed.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: "3rem", textAlign: "left" } }, /* @__PURE__ */ React.createElement("h3", { style: { fontFamily: "var(--font-heading)", fontSize: "1.5rem", fontWeight: 300, marginBottom: "1rem", textAlign: "center" } }, "Recently Viewed"), /* @__PURE__ */ React.createElement("div", { className: "siblings-strip" }, recentlyViewed.slice(0, 6).map((rv) => /* @__PURE__ */ React.createElement("div", { key: rv.sku_id, className: "sibling-card", onClick: () => onSkuClick(rv.sku_id, rv.product_name) }, /* @__PURE__ */ React.createElement("div", { className: "sibling-card-image" }, rv.primary_image && /* @__PURE__ */ React.createElement("img", { src: rv.primary_image, alt: rv.product_name, loading: "lazy" })), /* @__PURE__ */ React.createElement("div", { className: "sibling-card-name" }, rv.product_name), rv.retail_price && /* @__PURE__ */ React.createElement("div", { className: "sibling-card-price" }, "$", parseFloat(rv.retail_price).toFixed(2), rv.price_basis === "per_unit" ? "/ea" : "/sqft")))))) : /* @__PURE__ */ React.createElement("div", { className: "sku-grid" }, skus.map((sku) => /* @__PURE__ */ React.createElement(
    SkuCard,
    {
      key: sku.sku_id,
      sku,
      onClick: () => onSkuClick(sku.sku_id, sku.product_name || sku.collection),
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
  const tabs = ["overview", "orders", "quotes", "projects", "favorites", "account"];
  const tabIcons = {
    overview: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("rect", { x: "3", y: "3", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "3", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "3", y: "14", width: "7", height: "7", rx: "1" }), /* @__PURE__ */ React.createElement("rect", { x: "14", y: "14", width: "7", height: "7", rx: "1" })),
    orders: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" }), /* @__PURE__ */ React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }), /* @__PURE__ */ React.createElement("path", { d: "M16 10a4 4 0 01-8 0" })),
    quotes: /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" }), /* @__PURE__ */ React.createElement("line", { x1: "16", y1: "13", x2: "8", y2: "13" }), /* @__PURE__ */ React.createElement("line", { x1: "16", y1: "17", x2: "8", y2: "17" })),
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
  })))) : /* @__PURE__ */ React.createElement("div", { className: "trade-empty-state" }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }, /* @__PURE__ */ React.createElement("path", { d: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" }), /* @__PURE__ */ React.createElement("polyline", { points: "14 2 14 8 20 8" })), /* @__PURE__ */ React.createElement("p", null, "No quotes yet. Contact your trade representative to request a custom quote."))), tab === "projects" && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" } }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.875rem", color: "var(--stone-500)" } }, projects.length, " project", projects.length !== 1 ? "s" : ""), /* @__PURE__ */ React.createElement("button", { className: "btn", onClick: () => {
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
  )), col.items && col.items.length > 0 ? /* @__PURE__ */ React.createElement("div", { className: "trade-fav-grid" }, col.items.map((item) => /* @__PURE__ */ React.createElement("div", { key: item.id, className: "trade-fav-item" }, item.primary_image_url ? /* @__PURE__ */ React.createElement("img", { src: item.primary_image_url, alt: item.product_name, loading: "lazy", decoding: "async" }) : /* @__PURE__ */ React.createElement("div", { style: { height: 140, background: "var(--stone-100)" } }), /* @__PURE__ */ React.createElement("div", { className: "name" }, item.product_name), /* @__PURE__ */ React.createElement(
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
  ] }), /* @__PURE__ */ React.createElement("h1", null, "Collections"), /* @__PURE__ */ React.createElement("p", { className: "subtitle" }, "Explore our curated flooring collections from premium vendors worldwide."), loading ? /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, [0, 1, 2].map((i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("div", { className: "skeleton-collection-img" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-short" }), /* @__PURE__ */ React.createElement("div", { className: "skeleton-bar skeleton-bar-medium" })))) : collections.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "4rem", color: "var(--stone-600)" } }, /* @__PURE__ */ React.createElement("p", null, "No collections available yet.")) : /* @__PURE__ */ React.createElement("div", { className: "collections-grid" }, collections.map((c) => /* @__PURE__ */ React.createElement("div", { key: c.slug, className: "collection-card", onClick: () => onCollectionClick(c.name) }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-image" }, c.image && /* @__PURE__ */ React.createElement("img", { src: c.image, alt: c.name, loading: "lazy", decoding: "async" })), /* @__PURE__ */ React.createElement("div", { className: "collection-card-info" }, /* @__PURE__ */ React.createElement("div", { className: "collection-card-name" }, c.name), /* @__PURE__ */ React.createElement("div", { className: "collection-card-count" }, c.product_count, " product", c.product_count !== 1 ? "s" : ""))))));
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
  return /* @__PURE__ */ React.createElement("div", { className: "modal-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "modal-content", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("button", { className: "modal-close", onClick: onClose }, "\xD7"), submitted ? /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "2rem 0" } }, /* @__PURE__ */ React.createElement("div", { style: { width: 60, height: 60, borderRadius: "50%", background: "#d1fae5", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.5rem" } }, /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "#059669", strokeWidth: "2", style: { width: 30, height: 30 } }, /* @__PURE__ */ React.createElement("polyline", { points: "20 6 9 17 4 12" }))), /* @__PURE__ */ React.createElement("h2", { style: { marginBottom: "0.5rem" } }, "Thank You!"), /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.95rem" } }, "We'll be in touch within 1 business day.")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h2", null, "Request Installation Quote"), product && /* @__PURE__ */ React.createElement("p", { style: { color: "var(--stone-600)", fontSize: "0.875rem", marginBottom: "1.5rem" } }, "For: ", [product.collection, product.product_name].filter(Boolean).join(" ")), /* @__PURE__ */ React.createElement("form", { onSubmit: handleSubmit }, error && /* @__PURE__ */ React.createElement("div", { className: "checkout-error" }, error), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Name *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: name, onChange: (e) => setName(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Email *"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Phone"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "tel", value: phone, onChange: (e) => setPhone(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-row" }, /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "ZIP Code"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", value: zipCode, onChange: (e) => setZipCode(e.target.value), maxLength: 5 })), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Est. Square Feet"), /* @__PURE__ */ React.createElement("input", { className: "checkout-input", type: "number", value: sqft, onChange: (e) => setSqft(e.target.value) }))), /* @__PURE__ */ React.createElement("div", { className: "checkout-field" }, /* @__PURE__ */ React.createElement("label", null, "Message"), /* @__PURE__ */ React.createElement("textarea", { className: "checkout-input", value: message, onChange: (e) => setMessage(e.target.value), rows: 3, style: { resize: "vertical" } })), /* @__PURE__ */ React.createElement("button", { type: "submit", className: "btn", style: { width: "100%" } }, "Submit Inquiry")))));
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
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-image" }, item.primary_image && /* @__PURE__ */ React.createElement("img", { src: item.primary_image, alt: item.product_name, loading: "lazy", decoding: "async" })),
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-name" }, [item.collection, item.product_name].filter(Boolean).join(" ")),
    item.variant_name && /* @__PURE__ */ React.createElement("div", { className: "sku-card-variant" }, item.variant_name),
    /* @__PURE__ */ React.createElement("div", { className: "sku-card-price" }, item.retail_price ? "$" + parseFloat(item.retail_price).toFixed(2) + (item.price_basis === "per_sqft" ? "/sqft" : "") : ""),
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
