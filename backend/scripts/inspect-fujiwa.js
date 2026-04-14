import puppeteer from 'puppeteer';

const URLS = [
  'https://www.fujiwatiles.com/products/alco-deco-series/',
  'https://www.fujiwatiles.com/products/joya-100-series/',
  'https://www.fujiwatiles.com/products/hex-series/',
  'https://www.fujiwatiles.com/products/glasstel-series/',
];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  for (const url of URLS) {
    console.log('\n================================================================');
    console.log('  ' + url);
    console.log('================================================================');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    // Scroll to bottom so lazy-loaded images render
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        window.scrollBy(0, 500);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await new Promise((r) => setTimeout(r, 1000));

    const report = await page.evaluate(() => {
      // helper: find a sensible section label for an element
      function sectionLabel(el) {
        let node = el;
        while (node && node !== document.body) {
          const id = node.id ? `#${node.id}` : '';
          const cls = (node.className && typeof node.className === 'string')
            ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '';
          if (id || (cls && cls.length > 1)) {
            return `${node.tagName.toLowerCase()}${id}${cls}`;
          }
          node = node.parentElement;
        }
        return 'body';
      }

      function stripDims(u) {
        return u.replace(/-\d+x\d+(\.\w+)(?:\?.*)?$/, '$1');
      }

      // 1. WooCommerce product gallery (top of page)
      const wooGallery = [];
      document.querySelectorAll('.woocommerce-product-gallery img').forEach((img, i) => {
        wooGallery.push({
          idx: i,
          tag: 'woo-gallery',
          src: stripDims(img.getAttribute('data-large_image') || img.src || ''),
          alt: img.alt || '',
          class: img.className || '',
        });
      });

      // 2. Thumbnail strip under main image
      const wooThumbs = [];
      document.querySelectorAll('.flex-control-thumbs img, .woocommerce-product-gallery__image--placeholder img').forEach((img, i) => {
        wooThumbs.push({
          idx: i,
          tag: 'woo-thumb',
          src: stripDims(img.src || ''),
          alt: img.alt || '',
        });
      });

      // 2b. bc-variation-images
      const bcVar = [];
      document.querySelectorAll('img.bc-variation-image').forEach((img, i) => {
        const parent = img.closest('ul,div,section');
        bcVar.push({
          idx: i,
          src: stripDims(img.getAttribute('data-large_image') || img.getAttribute('data-src') || img.src || ''),
          alt: img.alt || '',
          parentTag: parent ? parent.tagName.toLowerCase() : '',
          parentCls: parent ? (parent.className || '').slice(0, 80) : '',
          width: img.naturalWidth,
          height: img.naturalHeight,
          displayW: img.width,
          displayH: img.height,
        });
      });

      // 2c. Look specifically for the single "main" product image
      const mainImg = document.querySelector('.woocommerce-product-gallery__image img, img.wp-post-image');
      const main = mainImg ? {
        src: stripDims(mainImg.getAttribute('data-large_image') || mainImg.src || ''),
        alt: mainImg.alt || '',
        width: mainImg.naturalWidth,
        height: mainImg.naturalHeight,
      } : null;

      // 3. Divi gallery module images — install gallery is usually built with Divi
      const diviGallery = [];
      document.querySelectorAll('.et_pb_gallery_item, .et_pb_gallery_image').forEach((el, i) => {
        const img = el.querySelector('img');
        if (!img) return;
        const caption = el.querySelector('.et_pb_gallery_title, .et_pb_gallery_caption, figcaption');
        diviGallery.push({
          idx: i,
          tag: 'divi-gallery',
          src: stripDims(img.src || ''),
          alt: img.alt || '',
          caption: caption ? caption.textContent.trim() : '',
          parent: el.className,
        });
      });

      // 4. Everything under .entry-content / .et_pb_section
      const contentImgs = [];
      document.querySelectorAll('img').forEach((img) => {
        const src = stripDims(img.getAttribute('data-large_image') || img.getAttribute('data-src') || img.src || '');
        if (!src || !src.includes('/wp-content/uploads/')) return;
        if (/logo|icon|placeholder|banner/i.test(src)) return;
        contentImgs.push({
          tag: 'all-img',
          src,
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
          section: sectionLabel(img),
        });
      });

      // 5. Product title + SKU from WooCommerce
      const title = (document.querySelector('h1.product_title, h1.entry-title') || {}).textContent || '';
      const sku = (document.querySelector('.sku') || {}).textContent || '';

      return {
        title: title.trim(),
        sku: sku.trim(),
        wooGallery,
        wooThumbs,
        bcVar,
        main,
        diviGallery,
        contentImgs,
      };
    });

    console.log('\n  MAIN product image (.woocommerce-product-gallery__image):');
    if (report.main) {
      console.log(`    ${report.main.src.split('/').pop()}  ${report.main.width}x${report.main.height}  alt="${report.main.alt}"`);
    } else {
      console.log('    (none)');
    }

    console.log(`\n  bc-variation-image elements: ${report.bcVar.length}`);
    report.bcVar.forEach((i) => {
      console.log(`    [${i.idx}] ${i.src.split('/').pop()}  nat=${i.width}x${i.height}  disp=${i.displayW}x${i.displayH}  parent=${i.parentTag}.${i.parentCls}`);
    });

    console.log('  Title:', report.title);
    console.log('  SKU:  ', report.sku);

    console.log('\n  WooCommerce Gallery (top main + thumbs):', report.wooGallery.length);
    report.wooGallery.forEach((i) => {
      console.log(`    [${i.idx}] ${i.src.split('/').pop()}  alt="${i.alt}"`);
    });

    console.log('\n  Divi Gallery (install photos with captions):', report.diviGallery.length);
    report.diviGallery.slice(0, 20).forEach((i) => {
      console.log(`    [${i.idx}] ${i.src.split('/').pop()}  caption="${i.caption}"`);
    });
    if (report.diviGallery.length > 20) console.log(`    ... +${report.diviGallery.length - 20} more`);

    // Group contentImgs by section so we see what section each image lives in
    console.log('\n  All /wp-content/ images by DOM section:');
    const bySection = new Map();
    report.contentImgs.forEach((i) => {
      const key = i.section;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(i);
    });
    for (const [section, imgs] of bySection) {
      console.log(`    [${section}]  (${imgs.length})`);
      imgs.slice(0, 8).forEach((i) => {
        console.log(`       ${i.src.split('/').pop()}  ${i.width}x${i.height}`);
      });
      if (imgs.length > 8) console.log(`       ... +${imgs.length - 8} more`);
    }
  }

  await browser.close();
})();
