// Canonical service-area list — the single source of truth for local SEO.
// Shared by seoRenderer.js (installation + per-city local pages + JSON-LD) and
// scripts/seo/build-local-pages.mjs (which mints one landing_pages row per city).
// Keep frontend/storefront.jsx SERVICE_AREAS identical (it can't import this — it's
// a browser bundle — so update both together).

export const SERVICE_AREAS = [
  { county: 'Orange County', cities: ['Anaheim','Fullerton','Irvine','Orange','Tustin','Santa Ana','Yorba Linda','Placentia','Brea','Buena Park','Huntington Beach','Costa Mesa','Newport Beach','Mission Viejo','Lake Forest','Laguna Hills'] },
  { county: 'Los Angeles County', cities: ['Long Beach','Cerritos','Lakewood','La Mirada','Whittier','Norwalk','Downey','Diamond Bar','West Covina','Pomona'] },
  { county: 'Riverside County', cities: ['Corona','Riverside','Eastvale','Norco','Jurupa Valley','Moreno Valley'] },
];

export function citySlug(city) {
  return String(city).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Flat [{ city, county, slug }] for iteration + slug→city lookup.
export const SERVICE_CITIES = SERVICE_AREAS.flatMap(a =>
  a.cities.map(city => ({ city, county: a.county, slug: citySlug(city) }))
);

export function cityBySlug(slug) {
  return SERVICE_CITIES.find(c => c.slug === slug) || null;
}
