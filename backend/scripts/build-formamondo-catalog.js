#!/usr/bin/env node
/**
 * Build the Forma Mondo catalog.json from the 2026 price list (PRICE LIST 2026.pdf).
 *
 * Forma Mondo — imported large-format porcelain tile distributor (Carson, CA — formamondo.com).
 * Onboarded as its OWN vendor carrying a single house brand (Forma Mondo). All product is
 * rectified large-format porcelain field tile (12x24 / 24x48 / 48x48). No trim/accessories
 * exist in the line, so nothing is attached (confirmed with owner 2026-08-01).
 *
 * MODEL (see [[variant-pill-independence]] / [[line-item-display]]):
 *   - Each collection = a `collection`; each COLOR within it = ONE product; the finish x size
 *     rows are its SKUs. All SKUs sell_by 'box', per_sqft. Color pills come from
 *     collection_siblings; finish + size are the in-product variant pills.
 *
 * PRICING (confirmed with owner 2026-08-01): the sheet column labeled "MSRP" is retail MSRP.
 *   Roma COST = MSRP / 2. Retail = cost x 1.6 nickel keystone (== 0.8 x MSRP, nickel-rounded).
 *
 * RESTONE appears in the price-list index but has NO priced page — it is omitted.
 *
 * Emits data/formamondo/catalog.json. Images are matched separately by
 * scrape-formamondo-images.js -> images.json.
 *
 * Usage: node scripts/build-formamondo-catalog.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'formamondo');

// ---- packaging presets (sqft_box, pcs_box, lbs_box, pallet_sqft) ----
const PK = {
  '12x24': { sqft_box: 11.63, pcs_box: 6, lbs_box: 56, pallet_sqft: 558.24 },
  '24x48': { sqft_box: 15.50, pcs_box: 2, lbs_box: 70, pallet_sqft: 558 },
  // 48x48 has two packings across the book: 1pc/16sf (Mapierre/Noa) and 2pc/31sf (Easy Life etc.)
  '48x48_1': { sqft_box: 15.50, pcs_box: 1, lbs_box: 73, pallet_sqft: 558 },
  '48x48_noa': { sqft_box: 15.50, pcs_box: 1, lbs_box: 70, pallet_sqft: 558 },
  '48x48_2': { sqft_box: 31.0, pcs_box: 2, lbs_box: 140, pallet_sqft: 930 },
  '48x48_558': { sqft_box: 31.0, pcs_box: 2, lbs_box: 140, pallet_sqft: 558 },
};
const sz = (s) => ({ '12x24': '12" x 24"', '24x48': '24" x 48"', '48x48': '48" x 48"' }[s]);

// row helper: r(size, finish, msrp, pkKey)
const r = (size, finish, msrp, pkKey) => ({ size, finish, msrp, pk: PK[pkKey || size] });

// ---- the 12 priced collections ----
const COLLECTIONS = [
  {
    name: 'MaPierre', slug: 'mapierre', look: 'Limestone', material: 'Porcelain',
    blurb: 'Inspired by Pierre de Bourgogne, the fine French finishing stone of Burgundy — a synthesis of the restrained, minimalist Nobile face and Ligne, a contemporary three-dimensional texture.',
    finishNote: 'Natural = Nobile face; Ligne = 3D texture.',
    colors: {
      Blanc: [r('12x24','Natural',8.90), r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_1'), r('24x48','Ligne',11.00)],
      Beige: [r('12x24','Natural',8.90), r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_1'), r('24x48','Ligne',11.00)],
      Gris:  [r('12x24','Natural',8.90), r('24x48','Natural',10.50), r('24x48','Ligne',11.00)],
      Noir:  [r('12x24','Natural',8.90), r('24x48','Natural',10.50), r('24x48','Ligne',11.00)],
    },
  },
  {
    name: 'Matera Stone', slug: 'matera-stone', look: 'Stone', material: 'Porcelain',
    blurb: 'Originating from a unique primordial block of stone — a surface composed of pebbles of different sizes on a rarefied, neutral background.',
    colors: {
      White: [r('24x48','Neutra R10',10.50), r('24x48','Neutra R11',10.70), r('24x48','Sassi',10.50), r('24x48','Ritmo',11.00)],
      Beige: [r('24x48','Neutra R10',10.50), r('24x48','Neutra R11',10.70), r('24x48','Sassi',10.50), r('24x48','Ritmo',11.00)],
    },
  },
  {
    name: 'Marvel Diva', slug: 'marvel-diva', look: 'Marble', material: 'Porcelain',
    blurb: 'A captivating porcelain collection celebrating the bold elegance of rare and precious marbles — vivid colors and striking veining, available in matte and polished finishes.',
    colors: {
      'Taj Mahal':     [r('24x48','Matte',10.50), r('24x48','Polished',13.00)],
      'Ice Crystal':   [r('24x48','Matte',10.50), r('24x48','Polished',13.00)],
      'White Everest': [r('24x48','Matte',10.50), r('24x48','Polished',13.00)],
      'Precious Brown':[r('24x48','Silk Matte',13.00)],
    },
  },
  {
    name: 'Travertini', slug: 'elysian-travertini', look: 'Travertine', material: 'Porcelain',
    blurb: 'A travertine-look collection that enhances many architectural and design styles in a natural, versatile manner, available vein cut and cross cut.',
    colors: {
      Pearl: [r('24x48','Vein Cut',10.50), r('24x48','Cross Cut',10.50)],
      Light: [r('24x48','Vein Cut',10.50), r('24x48','Cross Cut',10.50)],
      Misty: [r('24x48','Vein Cut',10.50), r('24x48','Cross Cut',10.50)],
    },
  },
  {
    name: 'Easy Life', slug: 'easylife', look: 'Concrete', material: 'Porcelain',
    blurb: 'Inspired by the Japanese Wabi Sabi style — a synthesis of tradition and industrial innovation with intense tactile and visual realism, embracing a nostalgic minimalism.',
    colors: {
      Vanilla:  [r('24x48','Silk Matte',11.00), r('48x48','Silk Matte',11.50,'48x48_2')],
      Porridge: [r('24x48','Silk Matte',11.00), r('48x48','Silk Matte',11.50,'48x48_2')],
      Mushroom: [r('24x48','Silk Matte',11.00)],
      Truffle:  [r('24x48','Silk Matte',11.00)],
      'Cool Spring': [r('24x48','Silk Matte',11.00)],
      'Warm Spring': [r('24x48','Silk Matte',11.00)],
    },
  },
  {
    name: 'Double', slug: 'double', look: 'Limestone', material: 'Porcelain',
    blurb: 'Inspired by Portland stone, a limestone conglomerate quarried off the coast of Dorset and used throughout historic London — cross or vein cut for two complementary aesthetics.',
    colors: {
      White: [r('24x48','Plain',10.50), r('24x48','Linear',10.50), r('24x48','Linear 3D Lux',12.20)],
      Beige: [r('24x48','Plain',10.50), r('24x48','Linear',10.50), r('24x48','Linear 3D Lux',12.20)],
      Mint:  [r('24x48','Plain',10.50), r('24x48','Linear',10.50)],
      Arrow: [r('24x48','Mix',13.00)],
    },
  },
  {
    name: 'Noa', slug: 'noa', look: 'Concrete', material: 'Porcelain', promo: true,
    blurb: 'A cutting-edge cement-look series with the innovative Artech finish, which uniquely captures the reality of the product — available in four captivating colours.',
    colors: {
      Light: [r('24x48','Natural',6.00), r('48x48','Natural',8.00,'48x48_noa')],
      Pearl: [r('24x48','Natural',6.00), r('48x48','Natural',8.00,'48x48_noa')],
      Sand:  [r('24x48','Natural',6.00), r('48x48','Natural',8.00,'48x48_noa')],
    },
  },
  {
    name: 'Volcano', slug: 'volcano', look: 'Stone', material: 'Porcelain', promo: true,
    blurb: 'Inspired by basalt stone and featuring the innovative Artech finish — designed to stand out both indoors and outdoors.',
    colors: {
      Ash: [r('24x48','Natural',6.00), r('24x48','Rubik',6.50)],
    },
  },
  {
    name: 'Alpi', slug: 'alpi', look: 'Stone', material: 'Porcelain', promo: true,
    blurb: 'Pietra di Alpi is a natural stone from the Italian Alps — a light grey with subtle white veining, marbled and elegant, versatile for facades, exteriors and interior cladding.',
    colors: {
      Grigio: [r('24x48','Natural',6.00)],
      Tesseo: [r('24x48','Mix',6.50)],
    },
  },
  {
    name: 'Boost Vision', slug: 'boost-vision', look: 'Concrete', material: 'Porcelain',
    blurb: 'Inspired by landscape design — a surface blending the materiality of stone with the fluidity of concrete for coherent, welcoming, versatile indoor and outdoor spaces. Designed by PARK, Milan.',
    colors: {
      Glow:  [r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_558')],
      Camel: [r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_558')],
    },
  },
  {
    name: 'Natural', slug: 'natural', look: 'Limestone', material: 'Porcelain',
    blurb: 'Inspired by Bianco di Siberia limestone (Maljat) from the mountains of Montenegro — warm, harmonious tones and subtly vibrant textures for a sense of balance and comfort.',
    colors: {
      White: [r('24x48','Field Tile',10.50), r('48x48','Field Tile',11.50,'48x48_558'), r('24x48','Strip',11.00)],
      Ivory: [r('24x48','Field Tile',10.50), r('48x48','Field Tile',11.50,'48x48_558'), r('24x48','Strip',11.00)],
    },
  },
  {
    name: 'Nyra', slug: 'nyra', look: 'Stone', material: 'Porcelain',
    blurb: 'A stone-effect collection developed with a biophilic approach in collaboration with Alberto Apostoli and Studio Apostoli — sophisticated textures and veins depicting a stone that does not exist in nature.',
    colors: {
      Star:     [r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_558')],
      Sunlight: [r('24x48','Natural',10.50), r('48x48','Natural',11.50,'48x48_558')],
    },
  },
];

// ---- helpers ----
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round2 = (n) => Math.round(n * 100) / 100;
const keystone = (cost) => round2(Math.round(cost * 1.6 / 0.05) * 0.05);

function build() {
  const products = [];
  for (const col of COLLECTIONS) {
    for (const [color, rows] of Object.entries(col.colors)) {
      const pkey = `FMO-${col.slug}-${slugify(color)}`;
      const skus = rows.map((row) => {
        const cost = round2(row.msrp / 2);
        const suffix = `${slugify(row.finish)}-${row.size}`;
        return {
          suffix,
          variant_name: `${row.finish} · ${sz(row.size)}`,
          size: row.size, size_nominal: sz(row.size),
          finish: row.finish,
          msrp: row.msrp, cost, retail: keystone(cost),
          sell_by: 'box', price_basis: 'per_sqft',
          sqft_box: row.pk.sqft_box, pcs_box: row.pk.pcs_box,
          lbs_box: row.pk.lbs_box,
          boxes_pallet: Math.round(row.pk.pallet_sqft / row.pk.sqft_box),
        };
      });
      products.push({
        pkey, name: color, color, collection: col.name, collectionSlug: col.slug,
        category: 'porcelain-tile', material: col.material, look: col.look,
        status: col.promo ? 'active' : 'active',
        promo: !!col.promo, blurb: col.blurb, finishNote: col.finishNote || null,
        skus,
      });
    }
  }
  return {
    vendor: {
      name: 'Forma Mondo', code: 'FMO', website: 'https://formamondo.com',
      email: null, phone: '(323) 800-0404',
      address: '2318 E. Del Amo Blvd, Carson, CA 90810',
      notes: 'Imported large-format porcelain tile distributor (Carson, CA). House brand Forma Mondo. FOB Carson. Price list = MSRP; Roma cost = MSRP/2, retail = cost x1.6 keystone.',
    },
    brand: { name: 'Forma Mondo', code: 'FMO', website: 'https://formamondo.com' },
    markup: 1.6,
    products,
  };
}

const catalog = build();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));

const nSku = catalog.products.reduce((a, p) => a + p.skus.length, 0);
const byCol = {};
for (const p of catalog.products) byCol[p.collection] = (byCol[p.collection] || 0) + 1;
console.log(`Built catalog.json: ${catalog.products.length} products (colors), ${nSku} SKUs`);
console.log('Colors per collection:', JSON.stringify(byCol));
console.log('Sample:', JSON.stringify(catalog.products[0].skus[0], null, 1));
