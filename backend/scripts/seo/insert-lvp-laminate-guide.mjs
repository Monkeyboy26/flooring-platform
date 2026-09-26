// Hand-authored pillar guide: LVP vs Laminate.
//
// Replaces the short AI-generated body on /guides/lvp-vs-laminate with a comprehensive,
// hand-written comparison (~1,800 words). Same standard as insert-porcelain-tile-guide.mjs:
// specific, honest about tradeoffs, grounded in real specs (wear-layer mils, AC ratings),
// typical market ranges clearly framed as estimates.
//
//   node scripts/seo/insert-lvp-laminate-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'lvp-vs-laminate',
  title: 'LVP vs Laminate Flooring: Which Should You Choose?',
  h1: 'LVP vs. Laminate: Which Should You Choose?',
  meta_title: 'LVP vs Laminate Flooring: Which Should You Choose? | Roma Flooring Designs',
  meta_description: 'LVP vs. laminate compared honestly — waterproofing, scratch resistance, feel, looks, cost installed, and the best choice room by room. From the flooring pros at Roma.',
  intro_html: `<p><strong>Luxury vinyl plank and laminate are the two most popular wood-look floors on the market, and from six feet away they can be hard to tell apart.</strong> Both click together as floating floors, both cost a fraction of hardwood, and both have gotten dramatically better in the last decade. But they're built from opposite materials — one is polymer through and through, the other is compressed wood fiber — and that single difference decides which one belongs in your room.</p>
<p>Here's the honest comparison: where each wins, where each fails, and how to choose by room. If you'd rather compare them side by side in person, <a href="/installation">our Anaheim showroom stocks both</a> — bring your room measurements and we'll quote material or material-plus-install on the spot.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Choose LVP</strong> anywhere water is part of life — kitchens, baths, laundry, entries, rentals, homes with pets or kids. <strong>Choose laminate</strong> when the room stays dry and you want the most convincing wood look and the most durable surface per dollar — living rooms, bedrooms, hallways, home offices.</p></div>

<h2>What each floor actually is</h2>
<p><strong>Luxury vinyl plank (LVP)</strong> is a layered polymer plank: a rigid or flexible vinyl core, a printed design layer, and a clear <em>wear layer</em> on top measured in mils. Because every layer is plastic, the plank itself is 100% waterproof — it simply doesn't care about standing water, only whether water sneaks past it to the subfloor. Most modern LVP is "rigid core" (you'll see SPC — stone-polymer composite — and WPC — wood-polymer composite), which is stiffer underfoot and hides small subfloor flaws better than the older flexible glue-down sheets and planks.</p>
<p><strong>Laminate</strong> is mostly real wood by weight: a dense fiberboard (HDF) core with a photographic design layer and a hard melamine wear surface rated on the <em>AC scale</em>. That core is its strength and its weakness — HDF is harder and more rigid than vinyl, which makes laminate feel more solid and resist dents better, but wood fiber swells if water reaches it, and a swollen edge never goes back down.</p>

<h2>Head to head</h2>
<table>
  <caption>LVP vs. laminate at a glance</caption>
  <thead><tr><th>Factor</th><th>LVP</th><th>Laminate</th></tr></thead>
  <tbody>
    <tr><td>Water</td><td>Waterproof plank</td><td>Water-resistant at best; core swells if soaked</td></tr>
    <tr><td>Scratches &amp; stains</td><td>Very good (20+ mil)</td><td>Excellent surface hardness (AC4+)</td></tr>
    <tr><td>Dents &amp; heavy furniture</td><td>Can dent under points</td><td>More resistant (hard HDF core)</td></tr>
    <tr><td>Wood-look realism</td><td>Good, improving fast</td><td>Best in class at each price</td></tr>
    <tr><td>Feel &amp; sound</td><td>Quieter, slightly softer</td><td>Harder, can sound hollow without a good pad</td></tr>
    <tr><td>Over concrete slabs</td><td>Excellent</td><td>Needs a vapor barrier</td></tr>
    <tr><td>Material cost</td><td>$2–$6/sq ft</td><td>$1–$4/sq ft</td></tr>
    <tr><td>Typical lifespan</td><td>10–25 years</td><td>10–25 years (dry rooms)</td></tr>
  </tbody>
</table>

<h2>Water: the deciding factor</h2>
<p>This is where most decisions should start and end. LVP's polymer construction means a dishwasher leak or an overflowing tub is a cleanup, not a claim. Laminate makers have made real progress — quality lines now carry surface-water warranties good for 24 to 72 hours — but those warranties cover water sitting <em>on top</em> of an intact floor. Water that finds a seam, a pet accident that goes unnoticed over a weekend, or a slow appliance drip reaches the HDF core, and swollen laminate can't be repaired, only replaced.</p>
<p>Our rule: <strong>in bathrooms and laundry rooms, laminate isn't a candidate at all</strong> — use LVP or, better for the long run, <a href="/guides/choosing-bathroom-floor-tile">porcelain tile</a>. In kitchens, LVP is the safer call; put laminate there only if you accept the risk for the look.</p>

<h2>Durability: read the spec, not the marketing</h2>
<ul>
  <li><strong>For LVP, the number that matters is wear-layer thickness.</strong> 12 mil suits light-traffic bedrooms; <strong>20 mil or more</strong> is the threshold for busy households, pets, and rentals; 22–28 mil is commercial grade. Core type matters less than the wear layer — don't pay up for a thicker plank with a thin wear layer.</li>
  <li><strong>For laminate, look for the AC rating.</strong> AC3 handles normal residential traffic; <strong>AC4</strong> is the sweet spot for busy homes and light commercial; AC5 is heavy commercial. That melamine surface is genuinely harder than vinyl — laminate shrugs off grit, chair legs, and dog claws better than similarly priced LVP.</li>
  <li><strong>Dents flip the comparison.</strong> Vinyl is a softer material, and heavy furniture on small feet can leave permanent impressions in LVP; laminate's HDF core resists them. Use wide furniture pads on either floor.</li>
  <li><strong>Sun matters in Southern California.</strong> Cheap vinyl can discolor in strong, direct sun through big sliders; quality lines carry UV-stable wear layers. Ask — we'll tell you which lines hold up.</li>
</ul>
<p>Sharing the house with a golden retriever? See <a href="/guides/best-flooring-for-pets">the best flooring for pets</a> — spoiler: it's a 20-mil-plus LVP or tile.</p>

<h2>Looks and feel: laminate's home turf</h2>
<p>Because laminate's printed layer rides on a perfectly flat, hard surface, manufacturers can emboss deep, registered texture — grain you can feel that lines up with the grain you see. At any given price, <strong>laminate usually looks and feels more like real hardwood</strong>, and it takes wider, longer plank formats gracefully. Premium LVP has closed most of the gap, but entry-level vinyl still reads as vinyl up close: shallower texture, repeating patterns, a slight sheen.</p>
<p>Underfoot, laminate feels firm and walks "solid" when installed over a quality pad; without one it can sound hollow and clicky. LVP is a touch softer and quieter — many rigid-core lines ship with an attached acoustic pad, which is worth having in two-story homes.</p>

<h2>Cost installed</h2>
<p>Typical market ranges: <strong>laminate material runs about $1–$4 per square foot, LVP about $2–$6</strong>, with designer lines of both above that. Professional floating installation for either typically adds <strong>$2–$4.50 per square foot</strong> in the Orange County market, plus prep: laminate over a concrete slab needs a vapor-barrier underlayment, and rigid-core LVP wants a flat slab (leveling compound is the usual surprise line). All-in, most projects land between <strong>$4 and $10 per square foot</strong> — run your rooms through our <a href="/guides/flooring-cost-calculator">flooring cost calculator</a>, and add 10% waste when ordering (<a href="/guides/how-to-measure-a-room-for-flooring">how to measure</a>).</p>

<h2>Room by room</h2>
<ul>
  <li><strong>Kitchen:</strong> LVP. The spill-and-drip reality of a kitchen favors waterproof, and modern LVP looks good doing it.</li>
  <li><strong>Bathrooms &amp; laundry:</strong> LVP or porcelain tile only. Laminate is out.</li>
  <li><strong>Living rooms, bedrooms, offices:</strong> either — this is where laminate's realism and hardness earn the nod if the budget is tight, or where a premium LVP keeps one product flowing through the whole floor plan.</li>
  <li><strong>Whole-house / open concept:</strong> one floor throughout looks best, and if that plan includes the kitchen, LVP wins by default.</li>
  <li><strong>Rentals:</strong> LVP, 20 mil+. Tenant-proof and water-forgiving.</li>
  <li><strong>Upstairs:</strong> either, with an acoustic pad — attached-pad LVP or laminate over a quality underlayment.</li>
</ul>

<h2>Lifespan, repairs, and resale</h2>
<p>Both floors are honest 10–25 year products depending on quality and traffic — and neither can be refinished, so the wear layer <em>is</em> the lifespan. Repairs favor floating floors in theory (unclick and swap a plank), in practice that means keeping a box of spares from your original lot. On resale, buyers read both as quality mid-range floors when they're in good shape; what hurts value is worn entry-level product, not the category. If you're chasing maximum home value in main living areas, that's the case for stepping up to <a href="/guides/engineered-vs-solid-hardwood">engineered hardwood</a> — or the zero-maintenance route, <a href="/guides/how-to-choose-porcelain-tile">wood-look porcelain tile</a>.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Room gets wet?</strong> LVP (or tile). Full stop.</li>
  <li><strong>LVP spec:</strong> 20+ mil wear layer for busy homes and pets; attached pad upstairs; UV-stable line for sun-blasted rooms.</li>
  <li><strong>Laminate spec:</strong> AC4, 8mm+ thickness, quality underlayment, vapor barrier over concrete.</li>
  <li><strong>Either:</strong> order 10% overage from one lot and keep the spares; check flatness on slab floors before install day.</li>
</ul>`,
  footer_html: `<p>The fastest way to decide is to walk on both. <strong>Roma Flooring Designs</strong> stocks LVP and laminate lines side by side at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring room dimensions and photos, and we'll narrow the field and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['lvp-plank', 'laminate', 'wood-look-tile'],
    angle: 'waterproofing, durability, feel, cost, installation, best rooms, resale.',
    faq: [
      ['Which is better for a kitchen: LVP or laminate?',
       'LVP. The vinyl plank itself is fully waterproof, so everyday kitchen spills and appliance drips are a cleanup rather than damage. Laminate’s wood-fiber core swells if water reaches a seam, and swollen laminate can’t be repaired.'],
      ['Is water-resistant laminate really waterproof?',
       'No. Modern laminate lines carry surface-water warranties (typically 24–72 hours of standing water on an intact floor), but water that penetrates a seam or edge still swells the HDF core permanently. That’s a meaningful improvement, not waterproofing.'],
      ['Which looks more like real hardwood?',
       'At any given price, laminate usually wins on realism — its hard, flat surface takes deep, registered embossing so the texture you feel matches the grain you see. Premium LVP has closed most of the gap; entry-level LVP is where the difference shows.'],
      ['Which is cheaper installed: LVP or laminate?',
       'Laminate, usually — material runs about $1–$4 per square foot vs. $2–$6 for LVP, and floating installation costs about the same for both. Most projects land between $4 and $10 per square foot all-in depending on product and prep.'],
      ['How long do LVP and laminate floors last?',
       'Both are 10–25 year floors depending on quality and traffic. Neither can be refinished, so buy the durability up front: a 20+ mil wear layer for LVP or an AC4 rating for laminate — and keep spare planks from your original lot for repairs.'],
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
