// Local service catalog — the single source of truth for the per-city service pages
// layered on top of the /flooring-installation/{city} hubs (see serviceAreas.js).
//
//   Material install pages : /flooring-installation/{city}/{material}
//   Remodel hub            : /remodeling/{city}
//   Remodel room pages     : /remodeling/{city}/{room}
//
// Shared by seoRenderer.js (crawler render + JSON-LD), scripts/seo/build-local-service-pages.mjs
// (mints landing_pages rows) and generate-local-service-content.mjs (AI copy). Keep the
// PRIORITY_CITIES / MATERIALS / REMODEL_ROOMS mirror in frontend/storefront.jsx identical —
// the browser bundle can't import this module.

import { SERVICE_CITIES } from './serviceAreas.js';

// Launch wave 1: core markets only (nested-URL, priority-cities-first rollout). Expand this
// list once these index and perform — build/generate scripts key off it, so adding a city
// name here (must match a SERVICE_CITIES city exactly) is all it takes to widen coverage.
export const PRIORITY_CITY_NAMES = [
  // Full Orange County coverage (home market)
  'Anaheim', 'Fullerton', 'Orange', 'Yorba Linda', 'Placentia', 'Brea',
  'Irvine', 'Tustin', 'Santa Ana', 'Buena Park', 'Huntington Beach',
  'Costa Mesa', 'Newport Beach', 'Mission Viejo', 'Lake Forest', 'Laguna Hills',
  // Priority LA + Riverside anchors
  'Long Beach', 'Corona', 'Riverside',
];

export const PRIORITY_CITIES = SERVICE_CITIES.filter(c => PRIORITY_CITY_NAMES.includes(c.city));

// Material install services. shopCategory = real categories.slug for the "Shop {material}"
// money-page link (verified against the live catalog). blurb feeds the Service OfferCatalog.
export const MATERIALS = [
  { slug: 'hardwood',      name: 'Hardwood Flooring',      short: 'Hardwood',       shopCategory: 'hardwood',
    blurb: 'Solid and engineered hardwood — nail-down, glue-down, and floating installs with expert acclimation and moisture control.' },
  { slug: 'luxury-vinyl',  name: 'Luxury Vinyl (LVP/LVT)', short: 'Luxury Vinyl',   shopCategory: 'luxury-vinyl',
    blurb: 'Waterproof click-lock LVP and glue-down LVT — durable, pet- and kid-friendly floors with meticulous subfloor prep.' },
  { slug: 'tile',          name: 'Tile & Porcelain',       short: 'Tile',           shopCategory: 'porcelain-tile',
    blurb: 'Porcelain and ceramic tile for floors, walls, showers, and backsplashes — set flat and true with proper waterproofing.' },
  { slug: 'natural-stone', name: 'Natural Stone',          short: 'Natural Stone',  shopCategory: 'natural-stone',
    blurb: 'Marble, travertine, slate, and quartzite installed and sealed with the care natural stone demands.' },
  { slug: 'carpet',        name: 'Carpet',                 short: 'Carpet',         shopCategory: 'carpet',
    blurb: 'Stretch-in and glue-down carpet for bedrooms, stairs, and living areas — clean seams and tight, lasting installs.' },
  { slug: 'laminate',      name: 'Laminate Flooring',      short: 'Laminate',       shopCategory: 'laminate-flooring',
    blurb: 'Fast, affordable floating laminate with seamless transitions and durable wear layers.' },
];

// Kitchen & bath remodeling — honest to what Roma actually self-performs: flooring, tile,
// countertops, and cabinetry. related = link targets for the internal mesh (category slug or
// a static page path starting with '/').
export const REMODEL_ROOMS = [
  { slug: 'kitchen',  name: 'Kitchen Remodeling',  short: 'Kitchen',
    blurb: 'Full kitchen surfaces: flooring, backsplash and wall tile, countertops, and cabinetry — coordinated by one licensed crew.',
    related: [{ label: 'Countertops', href: '/shop?category=countertops' }, { label: 'Cabinets', href: '/cabinets' }, { label: 'Tile & Porcelain', href: '/shop?category=porcelain-tile' }, { label: 'Flooring installation', href: '/installation' }] },
  { slug: 'bathroom', name: 'Bathroom Remodeling', short: 'Bathroom',
    blurb: 'Bathroom surfaces done right: waterproofed shower and floor tile, vanities, countertops, and stone — start to finish.',
    related: [{ label: 'Tile & Porcelain', href: '/shop?category=porcelain-tile' }, { label: 'Natural stone', href: '/shop?category=natural-stone' }, { label: 'Countertops', href: '/shop?category=countertops' }, { label: 'Cabinets', href: '/cabinets' }] },
];

export const materialBySlug = (slug) => MATERIALS.find(m => m.slug === slug) || null;
export const roomBySlug = (slug) => REMODEL_ROOMS.find(r => r.slug === slug) || null;
export const isPriorityCity = (citySlug) => PRIORITY_CITIES.some(c => c.slug === citySlug);
