/**
 * Check if Shopify has prices for items missing from the PDF
 */
const SHOPIFY_DOMAIN = 'thdistributors.com';
const FETCH_DELAY_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch Shopify products
const allProducts = [];
let page = 1;
while (true) {
  const url = `https://${SHOPIFY_DOMAIN}/products.json?limit=250&page=${page}`;
  const res = await fetch(url);
  if (res.status !== 200) break;
  const json = await res.json();
  if (!json.products || json.products.length === 0) break;
  allProducts.push(...json.products);
  if (json.products.length < 250) break;
  page++;
  await sleep(FETCH_DELAY_MS);
}

// Map variant SKUs to prices
let total = 0;
let withPrice = 0;
let noPrice = 0;
let zeroPrice = 0;
const priceRanges = {};

for (const product of allProducts) {
  for (const variant of (product.variants || [])) {
    const rawSku = (variant.sku || '').trim().toUpperCase();
    if (!rawSku) continue;
    const m = rawSku.match(/^(?:THD)?(\d{4}-\d{5})[A-Z]?$/);
    if (!m) continue;

    total++;
    const price = variant.price ? parseFloat(variant.price) : 0;
    if (price > 0) {
      withPrice++;
      const range = price < 5 ? '<$5' : price < 10 ? '$5-10' : price < 20 ? '$10-20' : '$20+';
      priceRanges[range] = (priceRanges[range] || 0) + 1;
    } else if (price === 0) {
      zeroPrice++;
    } else {
      noPrice++;
    }
  }
}

console.log("=== Shopify Price Analysis ===");
console.log("Total THD variants:", total);
console.log("With price > 0:", withPrice);
console.log("Price = 0:", zeroPrice);
console.log("No price:", noPrice);
console.log("\nPrice distribution:");
for (const [range, count] of Object.entries(priceRanges)) {
  console.log(`  ${range}: ${count}`);
}
