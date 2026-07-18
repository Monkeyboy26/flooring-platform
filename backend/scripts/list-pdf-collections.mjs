import fs from "fs";
const { PDFParse } = await import("pdf-parse");
const buf = fs.readFileSync("/app/data/thd-q3-2026.pdf");
const parser = new PDFParse({ data: buf });
const data = await parser.getText();
await parser.destroy();
const lines = data.text.split("\n").map(l => l.trim()).filter(Boolean);

const collections = new Set();
const itemRe = /^THD\d{4}-\d{5}/;
const collectionItems = {};

let currentColl = null;
for (const line of lines) {
  if (line.startsWith("Image\t") || line.startsWith("Image \t")) {
    const fields = line.split("\t").map(f => f.trim());
    if (fields.length >= 4 && fields[2] && fields[2] !== "Size") {
      currentColl = fields[2];
      collections.add(currentColl);
      if (!collectionItems[currentColl]) collectionItems[currentColl] = 0;
    }
  }
  if (currentColl && itemRe.test(line)) {
    collectionItems[currentColl]++;
  }
}

console.log("PDF Collections (" + collections.size + "):");
for (const c of [...collections].sort()) {
  console.log("  " + c + " (" + (collectionItems[c] || 0) + " items)");
}
