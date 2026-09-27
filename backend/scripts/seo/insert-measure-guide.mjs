// Hand-authored pillar guide: How to Measure a Room for Flooring.
//
// Replaces the short AI-generated body on /guides/how-to-measure-a-room-for-flooring
// with a practical hand-written walkthrough (~1,200 words): step-by-step method,
// irregular rooms, waste factors by material and pattern, carton math, and the
// material-specific quirks (carpet rolls, mosaic sheets, sqft-vs-carton pricing).
//
//   node scripts/seo/insert-measure-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'how-to-measure-a-room-for-flooring',
  title: 'How to Measure a Room for Flooring (Step by Step)',
  h1: 'How to Measure a Room for Flooring',
  meta_title: 'How to Measure a Room for Flooring (Step by Step) | Roma Flooring Designs',
  meta_description: 'Measure any room for flooring in four steps — irregular shapes, closets and doorways, waste factors by material and pattern, and how to convert square feet into cartons.',
  intro_html: `<p><strong>Every flooring project starts with one number, and most DIY estimates get it wrong in the same two places:</strong> forgetting the spaces attached to the room (closets, doorways, under the appliances) and ordering exactly the square footage measured — with no waste factor. The first mistake shorts the order; the second guarantees it.</p>
<p>Here's the whole method in four steps, the waste percentages the trade actually uses, and the quirks that change the math by material. Measure with this and your quotes get sharper too — or skip the tape measure entirely and <a href="/installation">book a free in-home measure</a>; exact quantities are on us.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Length × width in feet = square feet.</strong> Break odd rooms into rectangles and add them. Include closets, doorways, and under appliances. Then add <strong>10% waste</strong> (15% for patterns, large tile, or choppy rooms) and <strong>round up to full cartons</strong>. That final number — not the raw room size — is what you order.</p></div>

<h2>Step 1: Sketch first, measure second</h2>
<p>Draw the room's outline on paper — no artistry required — including every closet, alcove, bay, and doorway. The sketch is what catches the forgotten spaces: <strong>closet floors get flooring, doorways carry it to the next room's threshold, and refrigerators and stoves sit on finished floor</strong> (appliances move; floors shouldn't stop at their front feet). Walk the room once with the sketch before touching the tape.</p>

<h2>Step 2: Measure in rectangles</h2>
<p>Measure each rectangle at its <strong>widest and longest points</strong>, wall to wall, in feet and inches. For an L-shaped room, split it into two rectangles at the inside corner; for angled or curved walls, measure the bounding rectangle as if the wall were straight — the "extra" becomes cutting stock, which you'll want anyway. Convert inches to decimals (6" = 0.5'), and write every figure on the sketch as you go.</p>
<p>A laser measure makes this faster and reaches over furniture, but a tape and a helper do the same job. Measure twice where a number will multiply — a 6-inch error on a 20-foot wall is 10 square feet.</p>

<h2>Step 3: Add it up</h2>
<p>Multiply each rectangle's length × width, then add them all — main room, closets, alcoves, doorway strips. That's your <strong>net square footage</strong>. Two habits of people who do this professionally: keep each rectangle as its own line item (errors are findable later), and sanity-check the total against the room's feel — a typical bedroom is 120–200 sq ft, a living room 250–400. A wildly different number means a multiplication slip, not an unusual room.</p>

<h2>Step 4: Add waste — the step that isn't optional</h2>
<p>Every install cuts pieces at walls, and offcuts mostly can't reuse. Waste isn't padding for mistakes — it's geometry:</p>
<table>
  <caption>Waste factors by situation</caption>
  <thead><tr><th>Situation</th><th>Add</th></tr></thead>
  <tbody>
    <tr><td>Straight lay, simple room</td><td>10%</td></tr>
    <tr><td>Large-format tile or long planks</td><td>15%</td></tr>
    <tr><td>Diagonal, herringbone, chevron</td><td>15%</td></tr>
    <tr><td>Choppy room (many closets/angles)</td><td>15%</td></tr>
    <tr><td>Handmade / high shade-variation tile</td><td>15% (extra pieces to blend and cull)</td></tr>
  </tbody>
</table>
<p>Multiply: 300 sq ft × 1.10 = 330 sq ft to order. And plan to <strong>keep the leftovers</strong> — a box of spares from your original dye lot is the only guaranteed color match if a plank or tile ever needs replacing. Sizing and pattern effects on waste are covered deeper in <a href="/guides/tile-sizes-explained">the tile sizes guide</a>.</p>

<h2>Convert to cartons</h2>
<p>Flooring sells by the carton, and cartons don't match your number — each box covers a fixed area (printed on the spec sheet, often something like 19.4 sq ft for planks or 15.6 for tile). Divide your with-waste total by the carton coverage and <strong>round up to the next whole box</strong>: 330 ÷ 19.4 = 17.01 → 18 cartons. That rounding is your final, real quantity — and the reason two quotes for the "same" square footage can differ by a box.</p>

<h2>Material quirks worth knowing</h2>
<ul>
  <li><strong>Tile:</strong> sold by carton but priced per sq ft; trim pieces (bullnose, shower curbs) are ordered per piece, separately. Pattern layouts push waste to the 15% tier.</li>
  <li><strong>Mosaics:</strong> count in whole sheets (~1 sq ft each) — round up per wall or area, not across the whole job. Details in <a href="/guides/mosaic-tile-guide">the mosaic guide</a>.</li>
  <li><strong>Plank flooring (LVP, laminate, hardwood):</strong> straightforward carton math, but stairs are counted per stair (tread + riser), not by square feet — measure and list them separately.</li>
  <li><strong>Carpet:</strong> the exception to everything — it's cut from <strong>12-foot rolls</strong>, so a 13-foot-wide room needs a seam and more material than its area suggests, and quotes often come per square <em>yard</em> (multiply by 9). Let the estimator plan seams; roll goods punish DIY math hardest.</li>
  <li><strong>Coverage-critical rooms</strong> (kitchens, whole floors): confirm which direction planks will run before finalizing — direction changes the cut count at walls.</li>
</ul>

<h2>When to hand it off</h2>
<p>Your own measurement is plenty for budgeting and comparing quotes — pair it with the <a href="/guides/flooring-cost-calculator">cost calculator</a> and you'll walk into any showroom informed. For the final order, a professional measure earns its keep on: multi-room continuous installs (one layout across rooms), carpet seam planning, stairs, and anything patterned. Mismeasured flooring is the most expensive kind of math error — the material's cut, the lot's sold out, and the crew is standing there.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Sketch the room</strong> — closets, doorways, appliance zones included.</li>
  <li><strong>Rectangles, widest points,</strong> inches as decimals, measure twice.</li>
  <li><strong>Add 10–15% waste</strong> by the table above.</li>
  <li><strong>Round up to whole cartons</strong> (or sheets, or the roll width for carpet).</li>
  <li><strong>Order everything from one dye lot</strong> and keep the spares.</li>
  <li><strong>Stairs and patterns:</strong> get a professional measure before ordering.</li>
</ul>`,
  footer_html: `<p>Bring your sketch and numbers to <strong>Roma Flooring Designs</strong> (1440 S. State College Blvd, Suite 6M, Anaheim) and we'll turn them into carton counts and a real quote on the spot — or <a href="/installation">book a free in-home measure</a> and we'll handle the tape, the seams, and the waste math ourselves. Call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['porcelain-tile', 'lvp-plank', 'engineered-hardwood'],
    angle: 'measuring sqft, waste factor by material/pattern, cartons/boxes, diagonal/herringbone allowance.',
    faq: [
      ['How do I calculate square footage for flooring?',
       'Measure each room\'s length and width in feet at their widest points and multiply. Break L-shaped or irregular rooms into rectangles and add them together — including closets, doorways, and the floor under appliances. That total, plus a waste factor, is what you order.'],
      ['How much extra flooring should I order?',
       'Add 10% for a straight lay in a simple room, and 15% for large-format tile, long planks, diagonal or herringbone patterns, choppy rooms, or handmade tile. The extra covers the wall cuts every install makes — and the leftovers become your color-matched repair stock.'],
      ['How do I convert square feet to boxes of flooring?',
       'Divide your square footage (waste included) by the coverage printed on the carton — e.g., 330 sq ft ÷ 19.4 sq ft per box = 17.01, which rounds up to 18 boxes. Always round up to the next whole carton.'],
      ['Why is carpet measured differently?',
       'Carpet is cut from 12-foot rolls, so material depends on how the roll maps onto your room, not just the area — a 13-foot-wide room needs a seam and extra length. It\'s also often quoted per square yard (9 sq ft). Seam planning is the main reason to let a professional measure carpet.'],
      ['Do stairs count in square footage?',
       'No — stairs are measured and priced per stair (tread plus riser), separately from the flat square footage. List them individually, and get a professional measure for any project that includes them.'],
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
    console.log('Done.');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
