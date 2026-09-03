#!/usr/bin/env python3
"""Stage 2: match PDF catalog -> Woo products for names + images. EXACT matching only (never a wrong image)."""
import json, re, html
from collections import defaultdict, Counter
OUT='/Users/kianassarpour/Desktop/flooring-platform/backend/data/patricio'
cat=json.load(open(OUT+'/catalog_pdf.json'))
woo=json.load(open('/tmp/patricio/woo_all.json'))

def clean(s): return re.sub(r'\s+',' ',html.unescape(s or '').replace('“','"').replace('”','"').replace('–','-').replace('’',"'")).strip()
def norm(s): return re.sub(r'[^A-Z0-9]','',(s or '').upper())
def wcats(p): return [clean(c['name']) for c in p.get('categories',[])]
def imgs(p): return [i['src'] for i in p.get('images',[]) if i.get('src')]

CODE_RES=[re.compile(r'\bL-?\d+[A-Z]*\b',re.I),re.compile(r'\bPW\s?\d+\b',re.I),
          re.compile(r'\bHB\s?#?\s?\d+\b',re.I),re.compile(r'\bLN[R]?-[A-Z0-9/]+\b',re.I)]
NAME_STOP={'SANTA','BARBARA','MATTE','GLOSS','TILE','TALAVERA','SOLID','SUBWAY','RUSTICO','PURO','LA','PAZ','HANDCRAFTED','RELIEF','MEXICAN','NEW','DESIGN','THE','AND','WITH','TRIM','CORNER'}
def woo_keys(p):
    keys=set()
    if p.get('sku'): keys.add(norm(p['sku']))
    keys.add(norm(p['slug'].split('-')[0]))
    nm=clean(p['name'])
    for rx in CODE_RES:
        for mm in rx.findall(nm): keys.add(norm(mm))
    for tok in re.findall(r'\b[A-Z0-9]{3,6}\b',nm):      # all-caps model codes (VNOB, CFCR...)
        if tok.upper() not in NAME_STOP and re.search(r'[A-Z]',tok): keys.add(norm(tok))
    # NOTE: image-filename tokens deliberately NOT used as keys — they cross-contaminate
    # (an L124 photo whose filename mentions L97 wrongly matched design L97). Code identity
    # comes only from sku / slug / leading name token, and every match is deduped 1:1 below.
    keys.discard(''); return keys

by_cat=defaultdict(list)
for p in woo:
    for c in wcats(p): by_cat[c].append(p)
WK={id(p):woo_keys(p) for p in woo}

def find_by_code(codes, cats, used=None):
    want={norm(c) for c in codes}; want.discard('')
    for wc in cats:
        for p in by_cat.get(wc,[]):
            if used is not None and id(p) in used: continue   # 1:1 — a Woo product backs one design
            if WK[id(p)] & want: return p
    return None

# ---- color sections: derive Woo color, match EXACT norm or verified alias ----
def derive_color(name, section):
    n=clean(name)
    for junk in ['Solid Talavera Tile','Talavera Subway Tile','Subway Tile','Talavera Subway',
                 'Solid Talavera','Talavera Tile','Rustico -','Rustico','Solid','Talavera','Tile','Subway']:
        n=n.replace(junk,'')
    return norm(n)
# alias: catalog-color-norm -> woo-color-norm (only clearly-same pairs, human-verified)
ALIAS={'BLANCOMEX':'BLANCOMEXICANO','COBALT':'COBALTBLUE','BLANCOWHITE':'WHITE',
       'TURQUOISEWASH':'TURQUOISE'}
def build_color_index(cats):
    idx={}
    for wc in cats:
        for p in by_cat.get(wc,[]):
            c=derive_color(p['name'],wc)
            if c and c not in idx: idx[c]=p
    return idx

# Decorative/New/Puro: the Woo SKU & slug are unreliable (data-entry drift — e.g. the
# "L124" product carries sku 'L97', "PW132" carries slug 'pw131'). The LEADING code in the
# product NAME is authoritative, so match those sections on that alone.
NAME_CODE_SECTIONS={'Talavera Decorative','New Talavera','Puro'}
def lead_code(name):
    m=re.match(r'^(PW\s?\d+|L-?\d+[A-Z]*)\b', clean(name), re.I)
    return norm(m.group(1)) if m else None
name_idx_cache={}
def build_name_index(cats):
    idx={}
    for wc in cats:
        for p in by_cat.get(wc,[]):
            c=lead_code(p['name'])
            if c and c not in idx: idx[c]=p
    return idx

FB={'Handcrafted Relief Mexican La Paz Tiles':['Handcrafted Relief Mexican La Paz Tiles','Tile Patterns','La Paz Relief Tile Patterns'],
    'Talavera Decorative Tiles':['Talavera Decorative Tiles','New Talavera Designs','Tile Patterns'],
    'Solids':['Solids'],'Puro':['Puro','Puro Talavera Patterns','Tile Patterns'],'Talavera Subway Tiles':['Talavera Subway Tiles'],
    'Rustico Brick':['Rustico Brick'],
    'Solid Handcrafted Santa Barbara Tiles':['Solid Handcrafted Santa Barbara Tiles'],
    'Talavera Trim':['Talavera Trim','Trim'],
    'Relief Liners & Corner Pieces':['Relief Liners & Corner Pieces','Liners','Relief Liners on Natural Clay & Talavera Liners','Talavera Deco Liners & Corner Pieces'],
    'Mexican Pavers':['Mexican Pavers'],'Talavera Numerals':['Talavera Numerals'],
    'Talavera Murals':['Talavera Murals'],
    'Aqua Mix':['Aqua Mix','Sealers','Cleaners','Stains','Problem Solvers','Finishes']}

# trim keyword -> woo name contains (catalog design prefix : woo keyword)
TRIM_KW=[('vcap-corner','v-cap corner'),('vcap','v-cap'),('double-bullnose','bullnose'),('bullnose','bullnose'),
         ('pencil-liner','pencil'),('flat-corner','chair rail corner'),('chairrail','chair rail'),
         ('cornice','cornice'),('beak',None),('quarter-round','quarter round'),('outside-elbow','end cap')]
def find_trim(design, cats):
    for pre,kw in TRIM_KW:
        if design.startswith(pre) and kw:
            for wc in cats:
                for p in by_cat.get(wc,[]):
                    if kw in norm_name(p): return p
    return None
def norm_name(p): return clean(p['name']).lower()

COLOR_SECTIONS={'Solid Color','Subway','Rustico'}
color_idx_cache={}
stats=Counter(); matched=Counter(); used=set()
for p in cat:
    stats[p['section']]+=1
    wc=p.get('woo_cat'); fcats=FB.get(wc,[wc]) if wc else []
    m=None
    if p['section'] in COLOR_SECTIONS:
        if wc not in color_idx_cache: color_idx_cache[wc]=build_color_index(fcats)
        idx=color_idx_cache[wc]
        ck=norm(p['attrs'].get('color') or p['base_name'])
        m=idx.get(ck) or idx.get(ALIAS.get(ck,''))
        if m and id(m) in used: m=None            # 1:1 — never reuse a color's photo
    elif p['section']=='Talavera Trim':
        m=find_trim(p['design'],fcats)
    elif p['section']=='Pavers':
        # Saltillo -> Regular/Super Saltillo; Lincoln -> Lincoln
        kw='lincoln' if p['design']=='lincoln' else 'saltillo'
        for wc2 in fcats:
            for q in by_cat.get(wc2,[]):
                nn=norm_name(q)
                if kw in nn and ('super' in nn or 'regular' in nn or 'lincoln' in nn): m=q; break
            if m: break
    elif p['section'] in ('Numbers','Murals','Aqua Mix'):
        base=p['base_name']
        for stop in ['Aqua Mix','Talavera','House Number',' Mural','Number Frame']: base=base.replace(stop,'')
        base=base.strip(' -()')
        if base:
            for wc2 in fcats:
                for q in by_cat.get(wc2,[]):
                    if norm(base) and norm(base) in norm(clean(q['name'])): m=q; break
                if m: break
    elif p['section'] in NAME_CODE_SECTIONS:
        if wc not in name_idx_cache: name_idx_cache[wc]=build_name_index(fcats)
        nidx=name_idx_cache[wc]
        code=norm(p['design'])
        nc=nidx.get(code)
        # Prefer the product whose PRIMARY image filename actually contains the code — Woo
        # sometimes mislabels an image (e.g. the "PW148" product ships pw125.png while a
        # second "Puro Talavera 148" product carries the real PW148-pattern.jpg).
        m=None
        cands=([nc] if nc else [])+[q for wc2 in fcats for q in by_cat.get(wc2,[]) if q is not nc]
        for q in cands:
            if id(q) in used: continue
            first=imgs(q)[0] if imgs(q) else ''
            if code and code in norm(first.split('/')[-1]): m=q; break
        if not m and nc and id(nc) not in used: m=nc   # fall back to name match (keeps odd-filename images)
    else:
        m=find_by_code(p.get('woo_codes',[]),fcats,used=used)
    if m:
        matched[p['section']]+=1; used.add(id(m))
        p['name']=clean(m['name']); p['images']=imgs(m)[:6]; p['woo_permalink']=m.get('permalink')
    else:
        p.setdefault('name',p['base_name']); p['images']=[]

# ---- Day of the Dead: generated from Woo (PDF: 6x6 all designs $16.50) ----
dotd=0
for q in by_cat.get('Dia de los Muertos',[]):
    if not imgs(q): continue
    nm=clean(q['name']); sl=re.sub(r'[^a-z0-9]+','-',q['slug']).strip('-')[:30]
    cat.append({'section':'Day of the Dead','category':'talavera-tile','covering':False,'accessory':False,
        'design':'dotd-'+sl,'collection':'Talavera Day of the Dead','woo_cat':'Dia de los Muertos','woo_codes':[],
        'base_name':nm,'name':nm,'images':imgs(q)[:6],'woo_permalink':q.get('permalink'),
        'skus':[{'size':'6x6','cost':16.50,'vendor_sku':'DOTD-'+norm(q['slug'])[:16],'sqft':0.25,'variant':'6x6'}],
        'attrs':{'material':'Ceramic','country':'Mexico','collection':'Talavera Day of the Dead','type':'Day of the Dead'}})
    dotd+=1
stats['Day of the Dead']=dotd; matched['Day of the Dead']=dotd

json.dump(cat, open(OUT+'/catalog.json','w'), indent=1)
print('=== IMAGE MATCH COVERAGE ===')
for s in stats: print(f'  {s:20s} {matched[s]:3d}/{stats[s]:3d}')
print(f'TOTAL products with image: {sum(1 for p in cat if p.get("images"))}/{len(cat)}   Woo used: {len(used)}/{len(woo)}')
