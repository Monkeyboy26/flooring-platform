# Galleher Duffy — daily price + inventory scraper

Refreshes dealer **cost** (→ retail at keystone ×1.6) and **Company Stock inventory**
for the 5 Galleher house brands we carry (Monarch, Reward, GemCore, Palacio, Audacity)
from the login-gated Magento portal `galleherduffy.com`.

- **Scraper:** `scrapers/galleher-duffy.js` (drives an authed Chrome, paginates each
  brand's search, parses Product# + price + Company Stock, matches our SKUs by
  `vendor_sku`, updates `pricing` + `inventory_snapshots`).
- **Auth:** `scrapers/galleher-duffy-auth.js` — reCAPTCHA blocks headless login, so a
  **dealer session cookie** is used (`GALLEHER_COOKIES`), matching the `BOSPHORUS_COOKIES`
  pattern. (A persistent Chrome profile is also supported for environments where an
  in-container interactive login is possible, but the Docker container runs headless
  system-chromium so the cookie path is the practical one here.)
- **Registered:** `vendor_sources` row `scraper_key='galleher-duffy'`, schedule
  `0 11 * * *` (UTC ≈ 3 am Pacific), `is_active=false` until auth is seeded.

## Activate (one-time)

1. **Capture the dealer cookie.** In Chrome, logged in to galleherduffy.com →
   DevTools → Application → Cookies → `https://www.galleherduffy.com`. Copy these into a
   single `name=value; name=value` string:
   `PHPSESSID`, `tc_customerId`, `tc_customerGroup`, `dataservices_customer_group`,
   `authentication_flag`, `private_content_version`, `section_data_ids`.
2. **Set it** in `.env`:  `GALLEHER_COOKIES="PHPSESSID=…; tc_customerGroup=…; …"`
3. **Recreate the api** so it picks up the env:  `docker compose up -d api`
4. **Test it** (manual trigger, no waiting for the schedule):
   `POST /api/admin/vendor-sources/04e41586-dd02-4f9f-b35e-9d39a4f0e6da/scrape`
   (admin token) — watch the job under Admin → Scrape Jobs.
5. **Turn on the daily schedule:**
   `UPDATE vendor_sources SET is_active=true WHERE scraper_key='galleher-duffy';`
   then `docker compose restart api` (the scheduler registers active sources on boot).

## Maintenance

- The session cookie eventually lapses (days–weeks). When it does, the scrape logs
  `Galleher profile is not logged in` and emails the ops alert — just re-capture the
  cookie (step 1–3). Including `authentication_flag` / a "Remember me" login extends it.
- Prices auto-apply at cost ×1.6; SKUs with `pricing.retail_locked=true` are never
  overwritten. `$0.00` tiles are skipped so a real cost is never wiped.
- Inventory writes to warehouse `galleher` with 24 h freshness; the `GALL` vendor has
  `has_public_inventory=false`, so stock is internal/rep-facing only (flip that flag to
  surface it on the storefront).
