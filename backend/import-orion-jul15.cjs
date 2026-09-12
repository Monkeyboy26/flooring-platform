// One-off: import Orion styles present on the July-15-2026 net price list but
// absent from the catalog (not on orionflooring.com -> photoless). Hand-curated
// from the PDF. Idempotent by internal_sku. Usage: node import-orion-jul15.cjs
const { Pool } = require('pg');
const nn = v => { const c=Math.round(v*100), k=Math.floor((c-9)/10); return Math.max(9,k*10+9)/100; };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
// category, sell_by, price_basis, variant_type per bucket
const B = {
  porc: ['porcelain-tile','box','per_sqft','floor_tile'],
  wood: ['wood-look-tile','box','per_sqft','floor_tile'],
  wall: ['backsplash-wall','box','per_sqft','wall_tile'],
  mos:  ['mosaic-tile','unit','per_unit','mosaic'],
  trim: ['transitions-moldings','unit','per_unit','moulding'],
};
// [name, bucket, [[size,color,cost],...]]
const ITEMS = [
  // field porcelain tile
  ['Annapurna','porc',[['60x120','Nero',5.09],['12x24','Nero',4.69]]],
  ['Arenite Multi','porc',[['24x48','Multi',4.19]]],
  ['Atelier Silk','porc',[['24x48','',4.69]]],
  ['Atlas','porc',[['3x12','Grey',4.19],['3x12','Sky',4.19],['3x12','Snow',4.19]]],
  ['Augusta White','porc',[['24x48','White',5.19]]],
  ['Bibury','porc',[['24x48','Beige Onyx',4.19]]],
  ['Brera','porc',[['36x36','',4.19]]],
  ['Belcaire','porc',[['9.2x18.4','Gris Natural',2.89]]],
  ['Beluga','porc',[['3x12','Black White',4.19]]],
  ['Cement Wave Ash','porc',[['24x48','Ash',2.49]]],
  ['Charme','porc',[['24x24','Black',3.09],['24x24','Grey',3.09],['24x24','Ivory',3.09],['24x24','Pearl',3.09],['24x48','Ivory',4.09]]],
  ['Classic Cream Asia','porc',[['48x48','Cream',2.89]]],
  ['Eter','porc',[['24x48','Green',4.69]]],
  ['Gala','porc',[['12x24','River Veil',2.29],['12x24','Smooth Silk',2.29],['12x24','Winds',2.29]]],
  ['Gems','porc',[['12x24','Shanghai Fumee',2.89]]],
  ['Grand Antique Polished','porc',[['24x48','',4.69]]],
  ['Intrecci','porc',[['24x24','Bianco',3.09],['24x24','Miele',3.09],['24x24','Noce',3.09]]],
  ['Marmocim Classic','porc',[['16x16','',6.99]]],
  ['Marmocim Revolution','porc',[['16x16','',6.99]]],
  ['Muse Statuario','porc',[['32x32','',4.69],['24x48','',4.69]]],
  ['Muse Nero Marquina','porc',[['12x24','Polished',4.69],['24x24','Polished',4.69],['12x24','Satin',4.69]]],
  ['Ocean Turquoise','porc',[['12x24','Turquoise',4.09],['6x6','Turquoise',4.69]]],
  ['Pietra','porc',[['12.59x18.70','Mix',3.39],['12.59x18.70','Grafito',3.39]]],
  ['Pietrone Out','porc',[['12.5x24.5','Multi',3.79]]],
  ['Pulse','porc',[['12x24','Umber',2.49]]],
  ['Quartz','porc',[['12.5x24.5','Almond Silver',3.39]]],
  ['Roccione','porc',[['12.5x12.5','',3.79]]],
  ['Saint Andrews','porc',[['24x24','',2.89],['18x18','',2.89],['12x24','',2.89]]],
  ['Seda','porc',[['24x24','',2.19]]],
  ['Select Cream','porc',[['24x48','Cream',4.69]]],
  ['Serica','porc',[['24x48','Bone Ivory',4.19]]],
  ['Slash','porc',[['12x24','Almond Anthracite',3.49],['24x48','Almond Anthracite',4.19]]],
  ['Sparta','porc',[['12x24','Black',3.09],['12x24','Blue',3.09],['12x24','Red',3.09]]],
  ['Statuario Winds','porc',[['24x48','Polished',2.19]]],
  ['Tartan','porc',[['24x24','Moorland',2.49],['24x24','Taupe',2.49]]],
  // wood-look
  ['Dixie Cherry','wood',[['9.32x48','Cherry',2.49]]],
  ['Dixie Maple','wood',[['9.32x48','Maple',2.49]]],
  ['Helsinki','wood',[['10x60','Natural',3.59]]],
  ['Home Wengue','wood',[['32x32','',4.69]]],
  ['Project','wood',[['8x45.6','White',4.19]]],
  ['Sweden','wood',[['8x48','Olive',2.49]]],
  ['Time','wood',[['8x45.6','Grey',5.19]]],
  ['Trazzo','wood',[['24x24','Shell',2.49],['24x24','Wool',2.49],['24x24','Charcoal',2.49]]],
  ['Tudor','wood',[['6x36','Noce',2.89]]],
  ['Vermont Mix','wood',[['8x48','Mix',3.39]]],
  ['Vosges','wood',[['6x36','',2.89]]],
  ['Wooden Willow','wood',[['8x48','',4.69]]],
  // ceramic wall
  ['Moca Wall','wall',[['12x36','Wave',1.99],['12x36','Flat',1.89]]],
  ['San Felipe','wall',[['18x18','',1.29]]],
  ['San Marcos','wall',[['18x18','',1.29]]],
  ['Galary White','wall',[['12x36','Flat',2.29],['12x36','Wave',2.29]]],
  // glass mosaics (per-sheet)
  ['Aerial Copper','mos',[['12x12','',7.99]]],
  ['Aerial Mirage','mos',[['12x12','',7.99]]],
  ['Aerial Plum','mos',[['12x12','',7.99]]],
  ['Deco Copper','mos',[['12x12','',7.99]]],
  ['Deco Slate','mos',[['12x12','',7.99]]],
  ['Glasswood Slate','mos',[['12x12','',7.99]]],
  ['Inter Murano','mos',[['1x1','Golden Blue',7.29],['1x1','Light Green',7.29],['1x1','White Blue',7.29],['1x1','White Brown',7.29]]],
  ['Inter Trazzo','mos',[['2x2','',7.29]]],
  ['Inter Gala','mos',[['3x3','',7.29]]],
  ['Inter ColorTheory','mos',[['12x12','',7.29]]],
  // trim / accessories (per piece)
  ['Atlas Trim','trim',[['0.5x12','Grey',5.00]]],
  ['Beluga Trim','trim',[['0.5x12','',5.00]]],
];

async function main(){
  const pool=new Pool({host:process.env.DB_HOST||'db',port:+(process.env.DB_PORT||5432),
    database:process.env.DB_NAME||'flooring_pim',user:process.env.DB_USER||'postgres',password:process.env.DB_PASSWORD||'postgres'});
  const vid=(await pool.query("SELECT id FROM vendors WHERE code='169'")).rows[0].id;
  const cats={};
  for(const b of Object.values(B)){ if(!(b[0] in cats)){ const r=await pool.query('SELECT id FROM categories WHERE slug=$1',[b[0]]); cats[b[0]]=r.rows[0]?.id||null; } }
  let np=0,ns=0;
  for(const [name,bk,vars] of ITEMS){
    const [catSlug,sellBy,basis,vtype]=B[bk];
    const catId=cats[catSlug];
    let pid=(await pool.query('SELECT id FROM products WHERE vendor_id=$1 AND name=$2 LIMIT 1',[vid,name])).rows[0]?.id;
    if(!pid){
      pid=(await pool.query(
        `INSERT INTO products (vendor_id,name,collection,category_id,description_long)
         VALUES ($1,$2,$2,$3,$4) RETURNING id`,[vid,name,catId,`Orion ${name}`])).rows[0].id;
      np++;
    }
    const multi = vars.length>1;
    for(const [size,color,cost] of vars){
      const suffix = multi ? '-'+slug(color||size) : '';
      const isku=('ORN-'+slug(name)+suffix).slice(0,100);
      const vname=[color,size].filter(Boolean).join(' ')||size||null;
      const sk=await pool.query(
        `INSERT INTO skus (product_id,vendor_sku,internal_sku,variant_name,sell_by,variant_type)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (internal_sku) DO UPDATE SET variant_name=EXCLUDED.variant_name, sell_by=EXCLUDED.sell_by, updated_at=now()
         RETURNING id`,[pid,isku,isku,vname,sellBy,vtype]);
      const sid=sk.rows[0].id; ns++;
      await pool.query(
        `INSERT INTO pricing (sku_id,cost,retail_price,price_basis)
         VALUES ($1,$2,$3,$4) ON CONFLICT (sku_id) DO UPDATE SET cost=EXCLUDED.cost, retail_price=EXCLUDED.retail_price, price_basis=EXCLUDED.price_basis`,
        [sid,cost,nn(cost*1.6),basis]);
    }
  }
  console.log('products new:',np,' skus upserted:',ns,' styles:',ITEMS.length);
  await pool.end();
}
main();
