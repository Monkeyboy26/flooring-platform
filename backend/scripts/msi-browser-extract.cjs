/**
 * MSI Browser-Based Image Extraction
 *
 * Uses Puppeteer to visit MSI product pages (SPA) and extract
 * CDN image URLs from the rendered DOM. Inserts into DB.
 *
 * Usage: node backend/scripts/msi-browser-extract.cjs [--dry-run]
 */

const puppeteer = require('puppeteer');
const { Pool } = require('pg');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Product pages to visit — these are confirmed to exist on MSI's website
// Format: { sku, url, name }
const PAGES = [
  // Mosaic products with MSI pages (glass-mosaics, crystallized-glass, mosaic-hatches)
  { sku: 'SMOT-SGLSIL-AR8MM', url: '/glass-mosaics/ashlar-rock-interlocking-3d/', name: 'Ashlar Rock' },
  { sku: 'SMOT-BSLTB-BMP10MM', url: '/glass-mosaics/basalt-blue-bamboo/', name: 'Basalt Blue Bamboo' },
  { sku: 'SMOT-SGLSIL-BLOBLA8MM', url: '/glass-mosaics/blocki-blanco-interlocking/', name: 'Blocki Blanco' },
  { sku: 'SMOT-GLSST-CARBO6MM', url: '/glass-mosaics/carbonita-subway/', name: 'Carbonita Subway' },
  { sku: 'SMOT-GLSB-CARREF4MM', url: '/glass-mosaics/caribbean-reef/', name: 'Caribbean Reef' },
  { sku: 'SMOT-SGLSMT-CR8MM', url: '/glass-mosaics/castle-rock/', name: 'Castle Rock' },
  { sku: 'SMOT-GLSMTIL-CS8MM', url: '/glass-mosaics/cityscape-interlocking/', name: 'Cityscape' },
  { sku: 'SMOT-SPIL-COBRELLO8MM', url: '/glass-mosaics/cobrello-interlocking/', name: 'Cobrello' },
  { sku: 'SMOT-SGLSIL-CRIS8MM', url: '/glass-mosaics/cristallo-interlocking/', name: 'Cristallo' },
  { sku: 'THDWG-GLMT-CCB-8MM', url: '/glass-mosaics/crystal-cove-blend/', name: 'Crystal Cove' },
  { sku: 'SMOT-SGLSMT-DIA8MM', url: '/glass-mosaics/diamante-brick/', name: 'Diamante' },
  { sku: 'SMOT-SMTIL-ECLIP8MM', url: '/glass-mosaics/eclipse-interlocking/', name: 'Eclipse' },
  { sku: 'SMOT-GLS-ESP6MM', url: '/glass-mosaics/esperanza-hexagon/', name: 'Esperanza' },
  { sku: 'SMOT-GLSB-CR-GLI6MM', url: '/crystallized-glass-6mm/glissen/', name: 'Glissen' },
  { sku: 'SMOT-SGLSGG-KENSINGTN8MM', url: '/glass-mosaics/kensington-hexagon/', name: 'Kensington' },
  { sku: 'SMOT-GLS-LAZBRI4MM', url: '/glass-mosaics/lazio-brick/', name: 'Lazio' },
  { sku: 'SMOT-LILPAD-HON10MM', url: '/glass-mosaics/lilly-pad/', name: 'Lilly Pad' },
  { sku: 'SMOT-GLSMTIL-MA8MM', url: '/glass-mosaics/madison-avenue-interlocking/', name: 'Madison Ave' },
  { sku: 'SMOT-MONBLU-POL10MM', url: '/glass-mosaics/montague-blue-oak/', name: 'Montague' },
  { sku: 'SMOT-GLSBRK-OABLA6MM', url: '/glass-mosaics/oasis-blast/', name: 'Oasis Blast' },
  { sku: 'SMOT-SGLSMT-OC8MM', url: '/glass-mosaics/ocean-crest-brick/', name: 'Ocean Crest' },
  { sku: 'SMOT-GLSST-OCEAZU8MM', url: '/glass-mosaics/oceania-azul-subway/', name: 'Oceania Azul' },
  { sku: 'SMOT-GLS-SAN4MM', url: '/glass-mosaics/santiago/', name: 'Santiago' },
  { sku: 'SMOT-GLS-SILVA6MM', url: '/glass-mosaics/silva-oak-2-hexagon-6mm/', name: 'Silva Oak 2 Hex' },
  { sku: 'SMOT-SGLSGG-SG8MM', url: '/glass-mosaics/stonegate-interlocking/', name: 'Stonegate' },
  { sku: 'SMOT-GL-T-TAHBLU2.5X8', url: '/glass-mosaics/tahiti-blue/', name: 'Tahiti Blue' },
  { sku: 'SMOT-GLSIL-TAOS8MM', url: '/crystallized-glass-blend-8mm/taos-interlocking/', name: 'Taos Interlock' },
  { sku: 'SMOT-GLSPK-TAOS8MM', url: '/glass-mosaics/taos-picket/', name: 'Taos Picket' },
  { sku: 'SMOT-GLS-TEK36', url: '/glass-mosaics/tektalia-3x6/', name: 'Tektalia' },
  { sku: 'THDWG-IR-TT-4MM', url: '/glass-mosaics/treasure-trail-iridescent/', name: 'Treasure Trail' },
  { sku: 'SMOT-VALBLND-OCTEL10MM', url: '/crema-marfil/valencia-blend-elongated-octagon/', name: 'Valencia Blend' },
  { sku: 'SMOT-GLSGGBRK-VC8MM', url: '/glass-mosaics/venetian-cafe/', name: 'Venetian Cafe' },
  // Natural stone
  { sku: 'CPAREDON1212C', url: '/travertine/paredon-cream/', name: 'Paredon 12x12' },
  { sku: 'CPAREDON1818C', url: '/travertine/paredon-cream/', name: 'Paredon 18x18' },
  { sku: 'TCAPBLU412H', url: '/products/natural-stone-collections/basalt/basalt-blue/', name: 'Capril Blue' },
  { sku: 'TMAYWHI-PAT-BR', url: '/pavers/natural-stone/mayra-white/', name: 'Mayra White Pattern' },
  { sku: 'SMOT-BSLTB-3DH', url: '/slate/basalt-blue/', name: 'Neptune 3d' },
  { sku: 'CROMAN1224H', url: '/travertine/roman-vein-cut/', name: 'Roman Vein Cut H' },
  { sku: 'CROMAN1224P', url: '/travertine/roman-vein-cut/', name: 'Roman Vein Cut P' },
  { sku: 'SMOT-RUSTIQUE-3DIL', url: '/glass-mosaics/rustique-interlocking/', name: 'Rustique' },
  // Porcelain
  { sku: 'NPALMAP10X60', url: '/wood-look-tile/porcelain/palma/maple/', name: 'Palma Maple' },
  { sku: 'NPALOAK10X60', url: '/wood-look-tile/porcelain/palma/oak/', name: 'Palma Oak' },
  // Stacked stone
  { sku: 'NNORICE6x24', url: '/ledger-panels/nora-ice/', name: 'Nora Ice' },
  // Bologna/Cafe Noce (travertine mosaics)
  { sku: 'THDW3-T-CH3X6T', url: '/glass-mosaics/bologna-chiaro/', name: 'Bologna Chiaro' },
  { sku: 'THDW3-SH-CN-8MM', url: '/glass-mosaics/cafe-noce/', name: 'Cafe Noce' },
];

async function main() {
  console.log('MSI Browser-Based Image Extraction');
  console.log('='.repeat(60));
  if (DRY_RUN) console.log('DRY RUN');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let found = 0, notFound = 0, inserted = 0;

  for (const page of PAGES) {
    const fullUrl = `https://www.msisurfaces.com${page.url}`;
    let tab;
    try {
      tab = await browser.newPage();
      await tab.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      await tab.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 15000 });

      // Check if product exists
      const noProduct = await tab.evaluate(() => document.body.innerText.includes('No Product Found'));
      if (noProduct) {
        console.log(`  - ${page.name} (${page.sku}): No Product Found`);
        notFound++;
        await tab.close();
        continue;
      }

      // Extract CDN product images (not room scenes, not icons)
      const images = await tab.evaluate(() => {
        const imgs = document.querySelectorAll('img');
        const urls = new Set();
        imgs.forEach(img => {
          const src = img.src || img.dataset.src;
          if (src && src.includes('cdn.msisurfaces.com/images/') &&
              !src.includes('svg') && !src.includes('logo') && !src.includes('icon') &&
              !src.includes('trends') && !src.includes('roomscenes') &&
              !src.includes('videos') && !src.includes('thumbnails/') &&
              (src.includes('/mosaics/') || src.includes('/porcelainceramic/') ||
               src.includes('/naturalstone/') || src.includes('/colornames/') ||
               src.includes('/hardscaping/') || src.includes('/lvt/') ||
               src.includes('/backsplash/'))) {
            urls.add(src);
          }
        });
        return [...urls];
      });

      if (images.length === 0) {
        // Try broader search including thumbnails
        const allImages = await tab.evaluate(() => {
          const imgs = document.querySelectorAll('img');
          const urls = new Set();
          imgs.forEach(img => {
            const src = img.src || img.dataset.src;
            if (src && src.includes('cdn.msisurfaces.com') &&
                !src.includes('svg') && !src.includes('logo') && !src.includes('icon') &&
                !src.includes('trends') && !src.includes('roomscenes') && !src.includes('videos')) {
              urls.add(src);
            }
          });
          return [...urls];
        });
        if (allImages.length > 0) {
          images.push(allImages[0]);
        }
      }

      if (images.length > 0) {
        found++;
        const imgUrl = images[0];
        console.log(`  + ${page.name} (${page.sku}): ${imgUrl.split('/images/')[1]}`);

        // Look up SKU and insert
        const { rows: skus } = await pool.query(
          `SELECT s.id as sku_id, s.product_id FROM skus s JOIN products p ON s.product_id = p.id
           WHERE s.vendor_sku = $1 AND p.vendor_id = $2 AND s.status = 'active'`,
          [page.sku, VENDOR_ID]
        );

        if (skus.length > 0) {
          const { rows: existing } = await pool.query(
            'SELECT id FROM media_assets WHERE sku_id = $1 LIMIT 1', [skus[0].sku_id]);
          if (existing.length === 0 && !DRY_RUN) {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
              VALUES ($1, $2, 'primary', $3, $3, 0, NOW()) ON CONFLICT DO NOTHING`,
              [skus[0].product_id, skus[0].sku_id, imgUrl]);
            inserted++;
          }
        }
      } else {
        console.log(`  - ${page.name} (${page.sku}): No images found`);
        notFound++;
      }

      await tab.close();
    } catch (err) {
      console.log(`  ! ${page.name} (${page.sku}): Error - ${err.message}`);
      notFound++;
      if (tab) await tab.close().catch(() => {});
    }
  }

  await browser.close();

  // Final coverage
  const { rows: coverage } = await pool.query(`
    SELECT COUNT(DISTINCT s.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_img
    FROM skus s JOIN products p ON s.product_id = p.id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
  `, [VENDOR_ID]);

  console.log('');
  console.log('='.repeat(60));
  console.log(`  Found images: ${found}`);
  console.log(`  No images: ${notFound}`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Coverage: ${coverage[0].with_img}/${coverage[0].total} (${(100*coverage[0].with_img/coverage[0].total).toFixed(1)}%)`);
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
