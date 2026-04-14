const puppeteer = require('puppeteer');

const urls = [
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/bohol-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/joya-100-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/joya-600-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/tokyo-100-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/vigan-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/celica-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/gloss-solid-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/penny-round-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/unglazed-100-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/kawa-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/lantern-series/',
  'https://www.fujiwatiles.com/products/fujiwa-tile-collections/peb-series/',
];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  for (const url of urls) {
    console.log('\n' + '='.repeat(100));
    console.log('URL:', url);
    console.log('='.repeat(100));

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);

    try {
      await page.goto(url, { waitUntil: 'networkidle2' });

      const data = await page.evaluate(() => {
        const result = {};

        // 1. Page <title>
        result.pageTitle = document.title || '(none)';

        // 2. H1
        const h1 = document.querySelector('h1');
        result.h1 = h1 ? h1.innerText.trim() : '(none)';

        // 3. All h2/h3/h4 headings on the page
        result.headings = [];
        document.querySelectorAll('h2, h3, h4').forEach(el => {
          const txt = el.innerText.trim();
          if (txt) result.headings.push({ tag: el.tagName, text: txt });
        });

        // 4. Breadcrumb trail
        const breadcrumbEl = document.querySelector('.woocommerce-breadcrumb, .breadcrumb, nav.breadcrumb, .yoast-breadcrumb, .rank-math-breadcrumb');
        result.breadcrumb = breadcrumbEl ? breadcrumbEl.innerText.trim() : '(none found via selector)';
        // Also try aria breadcrumb
        const ariaBread = document.querySelector('[aria-label="breadcrumb"], [aria-label="Breadcrumb"]');
        if (ariaBread) result.ariaBreadcrumb = ariaBread.innerText.trim();

        // 5. WooCommerce variation form data
        const variationForm = document.querySelector('form.variations_form');
        if (variationForm) {
          const jsonData = variationForm.getAttribute('data-product_variations');
          if (jsonData) {
            try {
              const variations = JSON.parse(jsonData);
              result.variations = variations.map(v => ({
                variation_id: v.variation_id,
                sku: v.sku || '(no sku)',
                attributes: v.attributes || {},
                display_price: v.display_price,
                display_regular_price: v.display_regular_price,
                image_title: v.image && v.image.title ? v.image.title : null,
                image_alt: v.image && v.image.alt ? v.image.alt : null,
              }));
            } catch (e) {
              result.variationsParseError = e.message;
            }
          } else {
            result.variationFormNote = 'Form found but no data-product_variations attribute';
          }
        } else {
          result.variationFormNote = 'No variations_form found';
        }

        // 6. Color dropdown options
        result.colorOptions = [];
        const colorSelect = document.querySelector('select#pa_colors, select[name="attribute_pa_colors"], select#pa_color, select[name="attribute_pa_color"]');
        if (colorSelect) {
          colorSelect.querySelectorAll('option').forEach(opt => {
            if (opt.value) {
              result.colorOptions.push({ value: opt.value, text: opt.innerText.trim() });
            }
          });
        }

        // 7. Also check for any other attribute selects
        result.attributeSelects = [];
        document.querySelectorAll('table.variations select').forEach(sel => {
          const label = sel.closest('tr')?.querySelector('label, th')?.innerText?.trim() || sel.name;
          const opts = [];
          sel.querySelectorAll('option').forEach(opt => {
            if (opt.value) opts.push({ value: opt.value, text: opt.innerText.trim() });
          });
          result.attributeSelects.push({ label, name: sel.name, options: opts });
        });

        // 8. Product short description
        const shortDesc = document.querySelector('.woocommerce-product-details__short-description, .product-short-description');
        result.shortDescription = shortDesc ? shortDesc.innerText.trim() : '(none)';

        // 9. Product categories shown on page
        const catEl = document.querySelector('.posted_in, .product_meta .tagged_as');
        result.productCategory = catEl ? catEl.innerText.trim() : '(none)';

        // 10. Product meta (SKU, categories, tags)
        const metaEl = document.querySelector('.product_meta');
        result.productMeta = metaEl ? metaEl.innerText.trim() : '(none)';

        // 11. Product title from woocommerce
        const prodTitle = document.querySelector('.product_title, .entry-title');
        result.productTitle = prodTitle ? prodTitle.innerText.trim() : '(none)';

        // 12. Tab content headings / descriptions
        result.tabContent = [];
        document.querySelectorAll('.wc-tab, .woocommerce-Tabs-panel').forEach(tab => {
          const id = tab.id || '';
          const text = tab.innerText.trim().substring(0, 500);
          result.tabContent.push({ id, text });
        });

        return result;
      });

      // Print results
      console.log('\n--- Page Title ---');
      console.log(data.pageTitle);

      console.log('\n--- H1 ---');
      console.log(data.h1);

      console.log('\n--- Product Title (.product_title) ---');
      console.log(data.productTitle);

      console.log('\n--- Breadcrumb ---');
      console.log(data.breadcrumb);
      if (data.ariaBreadcrumb) console.log('Aria breadcrumb:', data.ariaBreadcrumb);

      console.log('\n--- Headings (h2-h4) ---');
      if (data.headings.length === 0) console.log('(none)');
      data.headings.forEach(h => console.log(`  <${h.tag}> ${h.text}`));

      console.log('\n--- Short Description ---');
      console.log(data.shortDescription);

      console.log('\n--- Product Meta ---');
      console.log(data.productMeta);

      console.log('\n--- Color Options (select) ---');
      if (data.colorOptions.length === 0) console.log('(none)');
      data.colorOptions.forEach(o => console.log(`  value="${o.value}" -> "${o.text}"`));

      console.log('\n--- All Attribute Selects ---');
      if (data.attributeSelects.length === 0) console.log('(none)');
      data.attributeSelects.forEach(s => {
        console.log(`  [${s.label}] name="${s.name}"`);
        s.options.forEach(o => console.log(`    value="${o.value}" -> "${o.text}"`));
      });

      console.log('\n--- WooCommerce Variations ---');
      if (data.variations) {
        data.variations.forEach(v => {
          console.log(`  Variation ID: ${v.variation_id}`);
          console.log(`    SKU: ${v.sku}`);
          console.log(`    Attributes: ${JSON.stringify(v.attributes)}`);
          console.log(`    Price: ${v.display_price} (regular: ${v.display_regular_price})`);
          if (v.image_title) console.log(`    Image Title: ${v.image_title}`);
          if (v.image_alt) console.log(`    Image Alt: ${v.image_alt}`);
        });
      } else {
        console.log(data.variationFormNote || '(no variation data)');
      }

      console.log('\n--- Tab Content ---');
      if (data.tabContent.length === 0) console.log('(none)');
      data.tabContent.forEach(t => console.log(`  [${t.id}]: ${t.text}`));

    } catch (err) {
      console.log('ERROR:', err.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log('\n\nDONE');
})();
