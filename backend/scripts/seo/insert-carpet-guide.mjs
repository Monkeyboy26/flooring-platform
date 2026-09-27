// Hand-authored pillar guide: Carpet Buying Guide.
//
// Replaces the short AI-generated body on /guides/carpet-buying-guide with a
// comprehensive hand-written guide (~1,300 words): fiber first, solution-dyed
// explained, pile styles, density-over-pile-height judging, padding as the hidden
// half, room fit, costs, maintenance-for-warranty.
//
//   node scripts/seo/insert-carpet-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'carpet-buying-guide',
  title: 'Carpet Buying Guide: Fibers, Pile & Padding',
  h1: 'The Carpet Buying Guide',
  meta_title: 'Carpet Buying Guide: Fibers, Pile & Padding | Roma Flooring Designs',
  meta_description: 'How to buy carpet that lasts — nylon vs. polyester vs. triexta vs. wool, solution-dyed explained, pile styles, why density beats pile height, and the padding that decides everything.',
  intro_html: `<p><strong>Carpet is bought with the hand and worn out by physics.</strong> Shoppers pick the softest sample on the rack; five years later the hallway is matted while the closet still looks new. The difference was never softness — it was fiber, density, and the pad nobody looked at.</p>
<p>Here's how to read a carpet like the specs matter, because they do: which fiber for which life, how to judge density in ten seconds, and why the padding under the carpet decides how long the carpet above it lasts. Then come <a href="/installation">step on real samples at our Anaheim showroom</a> — barefoot beats a spec sheet for the final call.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Pick the fiber first</strong> — nylon or triexta for traffic and longevity, solution-dyed polyester for value and stain-proof color, wool for luxury. <strong>Judge density, not pile height</strong> (bend the sample back; if you see backing easily, walk away). And <strong>never cheap out on the pad</strong> — it's the suspension system under the whole investment.</p></div>

<h2>Fiber first: the decision that decides the rest</h2>
<table>
  <caption>Carpet fibers compared</caption>
  <thead><tr><th>Fiber</th><th>Superpower</th><th>Honest weakness</th></tr></thead>
  <tbody>
    <tr><td>Nylon</td><td>Resilience — springs back from traffic for decades</td><td>Costs more; needs stain treatment (built into good lines)</td></tr>
    <tr><td>Triexta</td><td>Nylon-class durability + permanent built-in stain resistance</td><td>Newer fiber; slightly less "spring" than the best nylon</td></tr>
    <tr><td>Polyester (PET)</td><td>Value, vivid color, naturally stain-resistant</td><td>Mats and crushes in heavy traffic — keep it in bedrooms</td></tr>
    <tr><td>Wool</td><td>The luxury benchmark — feel, look, natural soil hiding</td><td>Price, and it wants professional care</td></tr>
    <tr><td>Olefin</td><td>Cheap, moisture- and fade-tolerant</td><td>Crushes easily — loops and utility spaces only</td></tr>
  </tbody>
</table>
<p>One term worth knowing before any showroom: <strong>solution-dyed</strong>. It means the color goes into the fiber when the strand is made — like a carrot, not a radish — so the color can't wash, wear, or even bleach out. For households with kids, pets, or sunlight, a solution-dyed fiber is the single most practical box to check. (It's also the carpet half of our <a href="/guides/best-flooring-for-pets">pet flooring guide</a>'s advice.)</p>

<h2>Pile styles: how the fiber is worn</h2>
<ul>
  <li><strong>Cut pile — plush &amp; texture:</strong> the classic soft bedroom carpet. Plush shows footprints and vacuum tracks (some love that; know yourself); textured versions hide them.</li>
  <li><strong>Frieze / twist:</strong> tightly twisted, slightly curled fibers that hide traffic and footprints — the practical family-room and stairs choice.</li>
  <li><strong>Loop (Berber):</strong> durable, casual, great at hiding dirt — but loops snag, and a cat or a dog's claw can pull a run. Loop-free homes for climbing pets.</li>
  <li><strong>Cut-and-loop patterns:</strong> sculpted geometry that hides everything; the designer's tool for high-traffic spaces that still want style.</li>
</ul>

<h2>Density beats pile height — the ten-second test</h2>
<p>Tall, loose pile feels glorious on the rack and collapses in the hallway. What survives traffic is <strong>how much fiber is packed per square inch</strong>, not how long the strands are. Two showroom tests:</p>
<ul>
  <li><strong>The bend-back test:</strong> fold a corner of the sample backward. The more backing grins through the gap, the sparser the carpet. Dense carpet barely shows a part.</li>
  <li><strong>The finger press:</strong> push a finger straight down. Quick, springy recovery signals twist and density; a slow, dented recovery predicts matting.</li>
</ul>
<p>When comparing specs: <strong>density first, face weight second, pile height last</strong> — and a higher <em>twist number</em> (turns per inch) is the quiet marker of a carpet built to hold its shape.</p>

<h2>Padding: the hidden half of the purchase</h2>
<p>The pad is the suspension system — it absorbs the impact that would otherwise grind the carpet backing against the subfloor. Three rules:</p>
<ul>
  <li><strong>Standard done right:</strong> an 8-pound rebond pad, 7/16", covers most homes. Heavy-traffic areas want <em>denser and thinner</em>, not thicker and squishier — a too-soft pad flexes the carpet backing until it breaks down.</li>
  <li><strong>Never reuse old pad</strong> under new carpet — it's already compressed into the old traffic pattern, and it voids most warranties.</li>
  <li><strong>Match the warranty:</strong> manufacturers specify pad density for coverage; a bargain pad can quietly cancel a 20-year warranty. A <strong>moisture-barrier pad</strong> is cheap insurance in kid- and pet-adjacent rooms.</li>
</ul>

<h2>Where carpet still wins</h2>
<p>Hard surfaces took the main floors, but carpet keeps three rooms for good reasons: <strong>bedrooms</strong> (warmth underfoot at 6 a.m. is the whole argument), <strong>media and family rooms</strong> (nothing absorbs sound like carpet), and <strong>stairs</strong> (traction and hush — spec a dense twist or patterned cut-loop there, it's the highest-wear surface in the house). Skip carpet in wet rooms entirely, and see the <a href="/guides/best-flooring-for-pets">pet guide</a> before carpeting around accident-prone animals.</p>

<h2>What it costs</h2>
<p>Typical Orange County ranges: <strong>material about $1.50–$5 per square foot</strong> (wool well above), <strong>pad $0.50–$1</strong>, and <strong>installation $1–$2</strong> — most whole-room projects land around <strong>$3.50–$8 per square foot installed</strong>. One quirk to know: carpet is often quoted by the <em>square yard</em> (multiply by 9 to compare) and cut from 12-foot rolls, so room dimensions drive seam placement and waste — <a href="/guides/how-to-measure-a-room-for-flooring">measure right</a> and let the estimator plan the seams. Ballpark any room with the <a href="/guides/flooring-cost-calculator">cost calculator</a>.</p>

<h2>Living with it (and keeping the warranty)</h2>
<p>Vacuum weekly — dry soil cutting fiber is what actually ages carpet — and schedule <strong>hot-water extraction every 12–18 months</strong>: most manufacturer warranties require documented professional cleaning on that cadence, and the receipts matter if you ever claim. Blot spills, never scrub, and treat stairs to an extra pass; they wear at multiples of flat floor.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Fiber to life:</strong> nylon/triexta for traffic, solution-dyed PET for bedrooms on a budget, wool for the splurge.</li>
  <li><strong>Solution-dyed</strong> whenever kids, pets, or sun are involved.</li>
  <li><strong>Bend-back test</strong> every sample; density &gt; face weight &gt; pile height.</li>
  <li><strong>8-lb pad minimum,</strong> denser on stairs and hallways, never reused.</li>
  <li><strong>Loops and climbing pets don't mix.</strong></li>
  <li><strong>Keep cleaning receipts</strong> — the warranty depends on them.</li>
</ul>`,
  footer_html: `<p>Carpet is the most tactile purchase in flooring — specs narrow the field, feet make the call. <strong>Roma Flooring Designs</strong> stocks nylon, triexta, polyester, and wool lines with pad options at our Anaheim showroom (1440 S. State College Blvd, Suite 6M); bring room dimensions and we'll plan seams, match pad to warranty, and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['broadloom-carpet'],
    angle: 'fiber types, pile height/density, padding, durability ratings, best rooms.',
    faq: [
      ['What is the most durable carpet fiber?',
       'Nylon is the traffic benchmark — it springs back from crushing better than any synthetic — with triexta close behind and adding permanent built-in stain resistance. Polyester is best kept to bedrooms; it resists stains well but mats under heavy traffic.'],
      ['What does solution-dyed carpet mean?',
       'The color is added when the fiber strand is made, so it runs all the way through — like a carrot rather than a radish. Solution-dyed carpet can\'t wash, wear, or bleach out, which makes it the practical choice for homes with kids, pets, or strong sun.'],
      ['Is thicker carpet better?',
       'No — density beats pile height. Tall, loose pile mats down in traffic; what lasts is fiber packed tightly per square inch with a high twist level. Bend a sample backward: the more backing you see through the pile, the sparser (and shorter-lived) the carpet.'],
      ['Does carpet padding really matter?',
       'It\'s half the purchase. The pad absorbs the impact that otherwise breaks down the carpet backing — use at least an 8-pound rebond pad, denser (not thicker) in heavy traffic, never reuse old pad, and match the manufacturer\'s pad spec or you can void the warranty.'],
      ['How much does carpet cost installed?',
       'In the Orange County market, most projects land around $3.50–$8 per square foot installed — roughly $1.50–$5 for material, $0.50–$1 for pad, and $1–$2 for labor, with wool above those ranges. Note carpet is often quoted per square yard (multiply by 9 to compare).'],
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
