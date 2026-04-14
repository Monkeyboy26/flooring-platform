# Roma Flooring Designs — Platform

Custom PIM + storefront for a flooring/remodeling e-commerce business. No Shopify.

## Stack

- **Database:** PostgreSQL (19 tables — see `database/schema.sql`)
- **Backend:** Node.js + Express (`backend/server.js` ~12.6K lines, monolithic)
- **Frontend:** 3 React SPAs using CDN React + in-browser Babel (no build step)
- **Infrastructure:** Docker Compose, Nginx reverse proxy, MinIO (S3), Redis
- **Scrapers:** 29 Puppeteer-based vendor scrapers (`backend/scrapers/`)

## Routing (nginx.conf)

| URL Path | File Served | Purpose |
|----------|-------------|---------|
| `/` | `frontend/storefront.html` | Unified storefront (homepage, shop, trade, cart, checkout) |
| `/shop`, `/shop/*` | `frontend/storefront.html` | Product browsing, detail pages |
| `/trade`, `/trade/*` | `frontend/storefront.html` | Trade landing, dashboard, bulk order |
| `/cart`, `/checkout`, `/account`, `/wishlist`, `/collections` | `frontend/storefront.html` | All customer-facing routes |
| `/admin` (direct) | `frontend/admin.html` | Internal PIM/admin dashboard |
| `/rep` (direct) | `frontend/rep.html` | Sales rep dashboard |
| `/api/*` | `backend/server.js` | REST API (proxied to port 3001) |

**Architecture:** `storefront.html` is the single unified SPA serving ALL customer-facing routes. It includes homepage with hero, product browsing, detail pages, cart, checkout, trade landing/dashboard, collections, wishlist, and account. The old `index.html` is legacy and no longer served by default.

## Ports

- Frontend (Nginx): **3000**
- API (Express): **3001**
- PostgreSQL: **5432**
- Redis: **6379**
- MinIO: **9000** (console: 9001)

## Key Conventions

- Prices from PostgreSQL come as strings — always `parseFloat()` before `.toFixed()`
- Flooring sold by **sqft** (coverage calculator, round up to full cartons/boxes)
- Accessories sold by **unit** (`sell_by: 'unit'`, `variant_type: 'accessory'`)
- `sell_by` field determines pricing display: `/sqft` vs `/ea`
- Typography: Cormorant Garamond (headlines) + Inter (body)
- Color palette: warm stone neutrals (`--stone-50` through `--stone-900`), gold/sage/terracotta accents

## Database Quick Reference

```
vendors → products → skus → packaging, pricing, sku_attributes
categories (self-referencing tree)
attributes / sku_attributes (EAV pattern)
margin_tiers (category/vendor/default scoped)
inventory_snapshots (time-series with fresh_until)
trade_memberships / trade_pricing
media_assets (primary/alternate/lifestyle/spec_pdf)
cart_items (sell_by column for sqft vs unit)
```

## Docker Commands

```bash
docker compose up -d          # Start all services
docker compose down           # Stop all services
docker compose restart api    # Restart backend after code changes
docker compose logs -f api    # Tail API logs
docker exec -it flooring-platform-db-1 psql -U postgres -d flooring_pim  # DB shell
```

---

## Agent Domains

When delegating work to subagents (Task tool), use these domain definitions to scope their work correctly.

### 1. Scraper Agent
**Scope:** `backend/scrapers/`
**Files:** 29 scraper modules + `base.js` (shared base class)
**Pattern:** Each scraper extends BaseScraper — fetch → parse → normalize → upsert
**Use for:** Building new vendor scrapers, fixing broken scrapers, adding data fields, handling auth/session scrapers
**Context needed:** Target vendor's website structure, `base.js` patterns, `database/schema.sql` for target tables

### 2. Storefront Agent
**Scope:** `frontend/storefront.html`
**Architecture:** Unified single-file React SPA (~5500 lines), `StorefrontApp` root component, SKU-centric routing
**API endpoints:** `/api/storefront/skus/:skuId`, `/api/storefront/collections/:slug`, `/api/cart/*`, `/api/trade/*`
**Use for:** Homepage, product browsing/detail, cart/checkout, trade landing/dashboard/bulk-order, collections, wishlist, account, search, filtering, mobile responsive
**Key components:** `Header` (two-row with mega menu), `HomePage`, `BrowseView`, `SkuDetailView`, `CollectionView`, `CartView`, `CheckoutView`, `TradePage`, `TradeDashboard`, `BulkOrderPage`, `CartDrawer`, `QuickViewModal`, `MobileNav`, `MobileSearchOverlay`, `SiteFooter`
**Note:** Uses `same_product_siblings` from API to show variant options and accessories. All customer-facing routes (/, /shop, /trade, /cart, etc.) are served by this single SPA.

### 3. Admin/Rep Agent
**Scope:** `frontend/admin.html` (~9800 lines) + `frontend/rep.html` (~4500 lines)
**Use for:** PIM data management, order management, customer/trade management, sales rep tools, vendor management, reporting
**Pattern:** Both are single-file React SPAs with tabbed navigation, data tables, modals

### 4. Backend API Agent
**Scope:** `backend/server.js` + `backend/db.js` + `backend/routes/health.js` + `database/`
**Structure:** Monolithic Express app with route groups: `/api/products`, `/api/storefront`, `/api/cart`, `/api/orders`, `/api/admin`, `/api/rep`, `/api/trade`, `/api/vendors`, `/api/samples`
**Use for:** New API endpoints, schema changes, business logic, email templates (Nodemailer), auth (JWT), pricing calculations
**Warning:** Changes here affect ALL frontends — test thoroughly

### 5. DevOps Agent
**Scope:** `docker-compose.yml`, `docker-compose.prod.yml`, `nginx.conf`, `.github/workflows/`, `scripts/`, `Dockerfile`
**Use for:** Container config, nginx routing, CI/CD pipeline, deployment scripts, environment setup
**Warning:** High-risk changes — confirm before modifying

---

## Common Workflows

**Adding a feature to the shop:**
1. Backend API Agent → add/modify endpoints in `server.js`
2. Storefront Agent → add UI in `storefront.html`
3. Test with `docker compose restart api` + reload browser at `localhost:3000/shop`

**Adding a feature to admin:**
1. Backend API Agent → add admin endpoints (under `/api/admin/*`)
2. Admin/Rep Agent → add UI in `admin.html`
3. Test at `localhost:3000/admin`

**Onboarding a new vendor:**
1. Scraper Agent → create `backend/scrapers/<vendor>.js`
2. Backend API Agent → add vendor record + source config
3. Admin Agent → verify vendor appears in admin UI

**Schema changes:**
1. Update `database/schema.sql` (source of truth)
2. Run `ALTER TABLE` via `docker exec` on live DB
3. Update any affected API queries in `server.js`
4. Update any affected frontend displays
