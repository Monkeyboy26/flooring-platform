// Render the Roma Flooring Designs text wordmark (email brand header) to PNGs
// with the real Google fonts, one per email background color, at 2x for retina.
// Run INSIDE the flooring-api container (Chromium + crashpad workaround proven
// by lib/documents.js launchPdfBrowser): node /app/data/gen-email-wordmark.mjs
import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

const OUT = process.env.WORDMARK_OUT || '/app/data/wordmark-out';
mkdirSync(OUT, { recursive: true });

const VARIANTS = [
  { name: 'email-wordmark-paper', bg: '#ece5d8' },  // _shell.js card paper
  { name: 'email-wordmark-white', bg: '#ffffff' },  // LOGO_LOCKUP white cards + vendor sample
  { name: 'email-wordmark-inbox', bg: '#f3f1ed' },  // reviewRequest inbox bg
];

const html = (bg) => `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400&family=Pinyon+Script&display=swap" rel="stylesheet">
<style>body{margin:0;background:${bg};}</style>
</head><body>
<div id="mark" style="display:inline-block;background:${bg};padding:8px 14px 10px;text-align:center;">
  <p style="margin:0;font-family:'Cormorant Garamond',serif;font-size:26px;line-height:1;font-weight:400;letter-spacing:0.34em;text-indent:0.34em;color:#1c1917;white-space:nowrap;">ROMA <span style="letter-spacing:normal;text-indent:0;">FLOORING</span></p>
  <p style="margin:-11px 0 0;font-family:'Pinyon Script';font-size:36px;line-height:1.15;color:#a87935;white-space:nowrap;">Designs</p>
</div>
</body></html>`;

const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const inContainer = chromePath === '/usr/bin/chromium';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromePath,
  env: inContainer
    ? { ...process.env, HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/.config', XDG_CACHE_HOME: '/tmp/.cache' }
    : undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--single-process', '--disable-crash-reporter', '--disable-crashpad'],
});
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 300, deviceScaleFactor: 2 });
for (const v of VARIANTS) {
  await page.setContent(html(v.bg), { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Block until both webfonts are actually usable — networkidle0 can hang on
  // the font CDN keep-alive, and a screenshot before fonts load = Times fallback.
  await page.waitForFunction(() => document.fonts.status === 'loaded'
    && document.fonts.check("26px 'Cormorant Garamond'")
    && document.fonts.check("36px 'Pinyon Script'"), { timeout: 30000 });
  const el = await page.$('#mark');
  const box = await el.boundingBox();
  await el.screenshot({ path: `${OUT}/${v.name}.png` });
  console.log(v.name, 'css-size:', Math.round(box.width) + 'x' + Math.round(box.height));
}
await browser.close();
