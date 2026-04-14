async function main() {
  // Crawl a category page and show what we extract
  const resp = await fetch("https://mapeihome.com/flooranddecor/product-category/grouts/", {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  const html = await resp.text();

  console.log("Page length:", html.length);

  // Show all product links
  console.log("\n=== Product links ===");
  const linkRegex = /href="(https?:\/\/mapeihome\.com\/[^"]+\/product\/[^"]+)"/gi;
  let m;
  const links = [];
  while ((m = linkRegex.exec(html)) !== null) {
    const slugMatch = m[1].match(/\/product\/([^/]+)\/?$/);
    if (slugMatch) links.push(slugMatch[1]);
  }
  console.log("Links found:", links.length);
  for (const l of [...new Set(links)]) console.log("  ", l);

  // Show all mapei CDN images
  console.log("\n=== cdnmedia images ===");
  const imgRegex = /(?:https?:)?\/\/cdnmedia\.mapei\.com\/images\/[^"'\s<>]+/gi;
  const imgs = [];
  while ((m = imgRegex.exec(html)) !== null) {
    imgs.push(m[0]);
  }
  console.log("CDN images found:", imgs.length);
  for (const i of [...new Set(imgs)]) console.log("  ", i.substring(0, 130));

  // Also check www.mapei.com images
  console.log("\n=== www.mapei.com images ===");
  const wwwRegex = /https?:\/\/www\.mapei\.com\/images\/[^"'\s<>]+products-images[^"'\s<>]+/gi;
  const wwwImgs = [];
  while ((m = wwwRegex.exec(html)) !== null) {
    wwwImgs.push(m[0]);
  }
  console.log("www images found:", wwwImgs.length);
  for (const i of [...new Set(wwwImgs)]) console.log("  ", i.substring(0, 130));

  // Now try the card regex from scraper
  console.log("\n=== Card regex (a > img) ===");
  const cardRegex = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>/gi;
  let cardCount = 0;
  while ((m = cardRegex.exec(html)) !== null) {
    console.log("  CARD:", m[1].match(/product\/([^/]+)/)?.[1], "->", m[2].substring(0, 80));
    cardCount++;
  }
  console.log("Card matches:", cardCount);

  // Show a snippet of HTML around a product
  const snippet = html.indexOf("flexcolor-cq");
  if (snippet > 0) {
    console.log("\n=== HTML around flexcolor-cq ===");
    console.log(html.substring(snippet - 200, snippet + 300));
  }
}

main().catch(e => console.error(e));
