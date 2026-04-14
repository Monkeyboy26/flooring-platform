async function main() {
  const resp = await fetch("https://noblecompany.com/products/tile-installation/sheet-membranes/", {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  console.log("Status:", resp.status, "URL:", resp.url);
  const html = await resp.text();
  console.log("Length:", html.length);

  // Find all links containing /products/
  const links = [];
  const linkRegex = /href="([^"]*\/products\/[^"]+)"/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    if (!m[1].includes("tile-installation")) links.push(m[1]);
  }
  console.log("\nProduct links:", links.length);
  for (const l of [...new Set(links)].slice(0, 20)) console.log("  ", l);

  // Find images
  const imgs = [];
  const imgRegex = /(?:src|data-src)="([^"]*(?:storage|images|products)[^"]*)"/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    imgs.push(m[1]);
  }
  console.log("\nImages:", imgs.length);
  for (const i of [...new Set(imgs)].slice(0, 20)) console.log("  ", i);

  // Show HTML snippet
  const aquaIdx = html.toLowerCase().indexOf("aquaseal");
  if (aquaIdx > 0) {
    console.log("\n=== Around aquaseal ===");
    console.log(html.substring(Math.max(0, aquaIdx - 300), aquaIdx + 300));
  } else {
    // Show first product area
    const prodIdx = html.toLowerCase().indexOf("product");
    if (prodIdx > 0) {
      console.log("\n=== Around 'product' keyword ===");
      console.log(html.substring(Math.max(0, prodIdx - 100), prodIdx + 500));
    }
    // Show sample of HTML
    console.log("\n=== HTML sample (chars 2000-4000) ===");
    console.log(html.substring(2000, 4000));
  }
}
main().catch(e => console.error(e));
