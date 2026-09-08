// Canonical facet slug generation — the SINGLE source of truth shared by
// build-landing-pages.mjs (which MINTS landing_pages rows) and seoRenderer.js
// (which builds product→facet internal links). These two MUST produce identical
// slugs for the same (attribute, value): if they drift, product pages link to a
// slug the landing page doesn't have → the facet page is orphaned (no inbound
// links, never discovered/ranked). This module exists specifically because that
// drift already happened once (size facets: "24x48" vs "24-x-48"). Do NOT
// re-implement either function anywhere — import them here.

export function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Size values are dimensional and slugify badly by default ("12 x 24" → "12-x-24",
// '4" x 4"' → "4-x-4"). Normalize sizes to a compact form first so the slug reads
// like the real dimension: strip inch/quote marks, collapse the x-separator, keep
// fractions as a single dash. Non-size facets use plain slugify.
export function facetSlug(attrSlug, value) {
  let v = String(value);
  if (attrSlug === 'size') {
    v = v.replace(/["'”″′’]/g, '')          // drop inch/quote marks
         .replace(/\s*(?:[x×X]|by)\s*/g, 'x') // "12 x 24" / "12 by 24" → "12x24"
         .replace(/\s*\/\s*/g, '-');         // fraction slash → single dash: "1/2" → "1-2"
  }
  return slugify(v);
}
