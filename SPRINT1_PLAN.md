# Sprint 1 — Stabilization & Foundation

## Objectives (Week 1)
1. Stabilize architecture without breaking current flows
2. Remove production-hosting blockers
3. Add quality gates for checkout-critical paths

## Completed in this kickoff
- Added first extracted backend route module:
  - `backend/routes/health.js`
- Mounted health router in `backend/server.js`
- Made backend port environment-driven:
  - `PORT = process.env.PORT || 3001`
- Set JSON request limit baseline (`2mb`)
- Replaced hardcoded frontend API base in:
  - `frontend/index.html`
  - `frontend/admin.html`
  - `frontend/rep.html`
  with environment-safe runtime host resolution

## Next implementation steps (in order)
1. **Backend modularization (non-breaking)**
   - Extract domains from `server.js` into route modules:
     - catalog, cart, checkout, auth, trade, admin, rep, scrapers
   - Keep existing endpoint contracts stable

2. **Validation + security baseline**
   - Add reusable request validators for checkout/order endpoints
   - Add rate limiting to auth/login + public write endpoints
   - Tighten CORS config by environment

3. **Quality gates (minimum viable tests)**
   - Add test runner and CI scripts
   - Cover critical flows:
     - cart add/update/delete
     - shipping estimate
     - create payment intent
     - place order

4. **Frontend migration prep**
   - Introduce Vite-based React app shell in parallel
   - Migrate current single-file app incrementally (no UX regression)

## Success criteria for Sprint 1
- No hardcoded localhost API dependencies in deployed frontend
- At least 3 major backend domains extracted from monolith safely
- Critical checkout flow has automated test coverage
- CI fails on lint/test breakages before deploy
