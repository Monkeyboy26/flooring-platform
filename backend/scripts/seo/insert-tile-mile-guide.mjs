// Hand-authored pillar guide: The Anaheim Tile Mile (shopper's guide).
//
// NEW guide (no AI-generated predecessor). Targets "tile mile anaheim",
// "anaheim tile district", "tile stores state college blvd", and the
// "best tile stores orange county" cluster — no editorial guide to the
// district exists anywhere (Yelp auto-pages own the SERP), so this is a
// rank-and-earn-links asset. Roma is physically on the Mile (1440 S SCB).
//
//   node scripts/seo/insert-tile-mile-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.
// Remember: 1h render cache — restart api after inserting.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'anaheim-tile-mile-guide',
  title: 'The Anaheim Tile Mile: How to Shop Orange County’s Flooring District',
  h1: 'The Anaheim Tile Mile: A Shopper’s Guide',
  meta_title: 'Anaheim Tile Mile Guide — How to Shop OC’s Flooring District | Roma Flooring Designs',
  meta_description: 'What the Anaheim Tile Mile is, the three kinds of showrooms along State College Blvd, and how to shop the district like a contractor — trade pricing, samples, dye lots, and comparing quotes.',
  intro_html: `<p><strong>Ask anyone in Orange County construction where to look at tile, and you'll get the same answer: State College Boulevard in Anaheim.</strong> The stretch locals call the "Tile Mile" holds one of the densest clusters of tile, stone, and flooring showrooms in Southern California — manufacturer design studios, wholesale warehouses, and independent dealers, door after door.</p>
<p>That density is great for shoppers and confusing for first-timers: some doors sell to anyone, some are trade-only, and some are showrooms where you can look but have to buy through a dealer. Here's how the district actually works and how to shop it well in a single afternoon.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p>The <strong>Anaheim Tile Mile</strong> is the run of flooring and tile businesses along <strong>South State College Boulevard</strong> in Anaheim, roughly between Ball Road and Katella Avenue. It mixes three kinds of showrooms — manufacturer studios, trade wholesalers, and independent retailers — and yes, <strong>homeowners can shop it</strong>: browse everywhere, buy from the retail dealers. Bring your room measurements and an afternoon.</p></div>

<h2>Why so many tile stores on one street?</h2>
<p>Flooring showrooms cluster for the same reason car dealerships do: the product has to be seen in person, and buyers want to compare. Over the past few decades the State College corridor — with its mix of warehouse space and showroom frontage near the 91 and 57 freeways — accumulated tile importers, stone yards, distributor branches, and dealer showrooms until the cluster itself became the draw. For you, that means the best comparison shopping in the county happens within a few minutes' drive: dozens of showrooms, thousands of tiles on display, one trip.</p>

<h2>The three kinds of doors (and why some won't sell to you)</h2>
<p>The Mile's biggest source of confusion is that its businesses run on three different models. Knowing which door you're walking through saves time:</p>
<table>
  <caption>Showroom types on the Tile Mile</caption>
  <thead><tr><th>Type</th><th>What it is</th><th>Can you buy?</th></tr></thead>
  <tbody>
    <tr><td><strong>Manufacturer studios</strong></td><td>Brand-owned design showrooms and sales centers (national names like Daltile and Marazzi have Anaheim locations)</td><td>Browse and spec freely — purchases usually go through a dealer or contractor account</td></tr>
    <tr><td><strong>Trade wholesalers</strong></td><td>Importers and distributors stocking pallets for the trade; "wholesale only" signs live here</td><td>Often view-only for homeowners; your contractor or dealer orders on your behalf</td></tr>
    <tr><td><strong>Independent retail dealers</strong></td><td>Showrooms that sell direct to homeowners <em>and</em> run trade accounts for pros</td><td>Yes — walk in, price, and order (this is what we are at Roma)</td></tr>
  </tbody>
</table>
<p>None of this is gatekeeping for its own sake — manufacturers and wholesalers are set up for pallet quantities and dealer logistics, not single-kitchen orders. The practical route for a homeowner: <strong>spec anywhere, buy through a retail dealer</strong>, who can usually source from the wholesale houses up the street anyway.</p>

<h2>How to shop the Mile in one afternoon</h2>
<ul>
  <li><strong>Come measured.</strong> Square footage (plus closets and doorways) turns "that's pretty" into a real quote on the spot. Four steps in <a href="/guides/how-to-measure-a-room-for-flooring">the measuring guide</a>.</li>
  <li><strong>Bring the room with you</strong> — photos, cabinet door or countertop sample, paint chips. Showroom lighting flatters everything; context keeps you honest.</li>
  <li><strong>Take samples home.</strong> Any good dealer will send you off with samples — check them in your own light, morning and evening, next to the cabinets. Buy nothing you've only seen under showroom LEDs.</li>
  <li><strong>Write down exact SKUs</strong> — collection, color, size, and finish — for anything you like. "The gray one from the third store" is unfindable by 4 pm.</li>
  <li><strong>Ask two questions everywhere:</strong> is it stocked locally or special-order (lead times differ by weeks), and is the price per square foot or per carton? Comparing quotes fairly needs both. The <a href="/guides/flooring-cost-calculator">cost calculator</a> converts sqft prices into real project totals with waste included.</li>
  <li><strong>Order from one dye lot, and keep the spares.</strong> Tile color shifts subtly between production runs — a quote that's a carton short today can mean a mismatched repair years from now. Waste factors by material are in <a href="/guides/how-to-measure-a-room-for-flooring">the measuring guide</a>.</li>
</ul>

<h2>How pricing works here</h2>
<p>Three things surprise first-time Mile shoppers. First, <strong>displayed prices are usually negotiable ranges, not sticker law</strong> — quantity, stock position, and whether you're bundling setting materials all move the number. Second, <strong>trade pricing is real</strong>: contractors and designers carry accounts with meaningful discounts, which is why your tile bid can beat the price you were quoted at the same counter. If you're doing multiple rooms, ask a dealer what their trade program requires — some (ours included) extend it to serious remodelers, not just licensed pros. Third, <strong>slabs and some imports are "call for price"</strong> — not evasion, just material whose cost moves with lots and freight.</p>
<p>When comparing quotes between showrooms, line up the whole number: material with waste, trim pieces (bullnose and edging are priced per piece, never per square foot), setting materials, delivery, and lead time. The cheapest per-square-foot number on the street is frequently not the cheapest kitchen.</p>

<h2>When to bring your contractor</h2>
<p>Solo is fine for browsing and sampling. Bring your installer when you're close to ordering: they'll catch the things that turn into change orders — substrate and leveling needs, transitions between rooms, whether that 48-inch tile needs a flatter slab than your house has, stair math. If the install is ours, <a href="/installation">book the free in-home measure</a> and skip the tape measure entirely.</p>

<h2>Make us your first stop — or your last</h2>
<p>Roma Flooring Designs sits on the Mile at <strong>1440 S. State College Blvd</strong>. Shoppers use us both ways: start here to browse the whole market at once — our showroom and <a href="/shop">online catalog</a> carry 26,000+ products across Emser, Daltile, MSI, Arizona Tile, Shaw, Bedrosians and two dozen other lines, with live pricing — or end here with your notes from up the street and let us quote the whole job, material through install. Either order works; we're happy to be the tiebreaker.</p>`,
  footer_html: `<p><strong>Roma Flooring Designs</strong> — on the Anaheim Tile Mile at 1440 S. State College Blvd, Suite 6M. Bring your measurements and we'll turn an afternoon of browsing into carton counts and a real quote, or <a href="/installation">book a free in-home measure</a>. Call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['porcelain-tile', 'mosaic-tile', 'natural-stone'],
    angle: 'Anaheim Tile Mile district guide: showroom types (manufacturer/wholesale/retail), shopping strategy, trade pricing, dye lots.',
    faq: [
      ['What is the Anaheim Tile Mile?',
       'It’s the local name for the cluster of tile, stone, and flooring showrooms along South State College Boulevard in Anaheim — one of the densest concentrations of flooring businesses in Southern California, mixing manufacturer design studios, trade wholesalers, and independent retail dealers.'],
      ['Where is the Tile Mile located?',
       'Along South State College Boulevard in Anaheim, roughly between Ball Road and Katella Avenue, near the 57 and 91 freeways. Most showrooms sit within a few minutes’ drive of each other, which is what makes one-afternoon comparison shopping possible.'],
      ['Can homeowners shop the Tile Mile, or is it trade-only?',
       'Homeowners are welcome. Manufacturer studios and wholesale warehouses may be browse-only — purchases route through a dealer — but independent retail showrooms like Roma Flooring Designs sell directly to homeowners and can source from the wholesale houses on your behalf.'],
      ['Are Tile Mile prices better than big-box stores?',
       'Usually for anything beyond builder-basic: the selection is far deeper, displayed prices are typically negotiable with quantity, and dealers quote complete jobs (material, waste, trim, delivery) rather than a per-box shelf price. Compare total project quotes, not per-square-foot stickers.'],
      ['How do I get trade pricing on the Tile Mile?',
       'Contractors and designers open trade accounts with individual dealers — requirements vary by store. Some dealers, including Roma, extend trade programs to repeat remodelers and multi-room projects, not just licensed pros. Ask what each showroom’s program requires.'],
    ],
  },
};

async function upsertGuide(g) {
  const sql = `
    INSERT INTO landing_pages
      (type, slug, title, h1, meta_title, meta_description, intro_html, content_html, footer_html,
       filter_json, is_indexable, content_status, created_at, updated_at)
    VALUES
      ('guide', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, true, 'reviewed', now(), now())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1, meta_title = EXCLUDED.meta_title,
      meta_description = EXCLUDED.meta_description, intro_html = EXCLUDED.intro_html,
      content_html = EXCLUDED.content_html, footer_html = EXCLUDED.footer_html,
      filter_json = EXCLUDED.filter_json, is_indexable = true, content_status = 'reviewed',
      updated_at = now()
    RETURNING slug, (xmax = 0) AS inserted`;
  const params = [g.slug, g.title, g.h1, g.meta_title, g.meta_description,
    g.intro_html, g.content_html, g.footer_html, JSON.stringify(g.filter_json)];
  if (DRY) { console.log(`[dry-run] would upsert guide: ${g.slug}`); return; }
  const res = await pool.query(sql, params);
  const row = res.rows[0];
  console.log(`${row.inserted ? 'INSERTED' : 'UPDATED '} guide: /guides/${row.slug}`);
}

(async () => {
  try {
    await upsertGuide(GUIDE);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
