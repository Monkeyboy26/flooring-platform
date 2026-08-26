#!/usr/bin/env python3
import json, re, glob, os
from collections import OrderedDict

BASE = os.path.dirname(os.path.abspath(__file__))
prods = json.load(open(os.path.join(BASE,'products-p1.json')))['products']
colmeta = {c['handle']: c['title'] for c in json.load(open(os.path.join(BASE,'collections.json')))['collections']}

# --- collection membership from collection endpoints ---
mem = {}
for f in glob.glob(os.path.join(BASE,'cols','*.json')):
    h = os.path.basename(f)[:-5]
    for p in json.load(open(f)).get('products', []):
        mem.setdefault(p['handle'], set()).add(h)

META = {'all-hardwood','2018-new-products','2019-new-products','new-for-2020','frontpage','all-variants'}

# Title-prefix -> collection handle fallback (for products not in any specific endpoint)
PREFIX_TO_HANDLE = {
    'Provence III': 'provence-iii',
    'Avalon': 'avalon',
    'Costa': 'costa',
    'Mill Creek': 'mill-creek',
    'Sylvania': 'sylvania',
    'Islands': 'islands',
    'Urbano': 'urbano',
    'Heritage': 'heritage',            # no collection endpoint on site
    'Terreno': 'terreno',
    'Europa': 'europa',
    'El Paso': 'el-paso',
    'Castillo': 'castillo',
    'Camino II': 'camino-ii',
}
# ensure heritage title in colmeta
colmeta.setdefault('heritage', 'Heritage')

def clean_text(html):
    t = re.sub('<[^>]+>', ' ', html)
    t = t.replace('&amp;','&').replace('&nbsp;',' ').replace('&rsquo;',"'").replace('&ldquo;','"').replace('&rdquo;','"').replace('&frac12;','1/2').replace('&frac14;','1/4').replace('&frac34;','3/4')
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def grab(txt, label, nextlabels):
    # capture value after LABEL: up to the next known label or end
    stop = '|'.join(re.escape(l) for l in nextlabels)
    m = re.search(rf'{label}\s*:\s*(.*?)(?=\s*(?:{stop})\s*:|$)', txt)
    if not m: return None
    v = m.group(1).strip(' .')
    return v or None

ALL_LABELS = ['SPECIES','THICKNESS','WIDTH','LENGTH','TOP LAYER','TEXTURE','GRADE','BACKING','FINISH','SHEEN','TREATMENT','EDGE']

def master_img(src):
    src = src.split('?')[0]
    # strip trailing _NNNxNNN or _NNNx or _xNNN size suffix before extension
    src = re.sub(r'_(\d+)?x(\d+)?(?:_crop_[a-z]+)?(\.[a-zA-Z]+)$', r'\3', src)
    return src

def infer_construction(species, thickness, tags, backing):
    tagset = {t.lower() for t in tags}
    if 'solid' in tagset:
        return 'solid'
    if backing and 'plywood' in backing.lower():
        return 'engineered'
    # all reward live catalog is engineered hardwood except Heritage (solid)
    return 'engineered'

collections = OrderedDict()
def get_col(handle):
    if handle not in collections:
        collections[handle] = {'name': colmeta.get(handle, handle), 'handle': handle, 'products': []}
    return collections[handle]

all_handles_seen = set()
for p in prods:
    all_handles_seen.add(p['handle'])
    txt = clean_text(p['body_html'])
    spec = {}
    for lab in ALL_LABELS:
        spec[lab] = grab(txt, lab, ALL_LABELS)
    # SHEEN is often the last spec label -> value bleeds into description.
    # Keep only the short sheen token(s): cut at first long run / sentence boundary.
    if spec.get('SHEEN'):
        s = spec['SHEEN']
        # sheen values are short (e.g. 'Ultra-matte', 'Matte', 'Semi-gloss', 'Satin')
        m = re.match(r'^([A-Za-z][A-Za-z\-/ ]{0,18}?)(?=\s+[A-Z][a-z]|\s+(?:Authentic|Reward|The|Install|A |An |With|Our|This|These|Warranty|See)\b|$)', s)
        spec['SHEEN'] = (m.group(1).strip() if m else s.split('  ')[0]).strip(' .')
    # normalize split-word artifacts like 'oxid e' -> 'oxide'
    for k in ('FINISH','TEXTURE','GRADE'):
        if spec.get(k):
            spec[k] = re.sub(r'([a-z]) ([a-z])\b(?=\s|$)', lambda m: m.group(1)+m.group(2) if len(m.group(2))<=2 else m.group(0), spec[k])
            spec[k] = re.sub(r'\s+', ' ', spec[k]).strip(' .')

    # collection assignment
    endpoint_cols = mem.get(p['handle'], set()) - META
    if endpoint_cols:
        handle = sorted(endpoint_cols)[0]
    else:
        handle = None
        for pref, h in PREFIX_TO_HANDLE.items():
            if p['title'].startswith(pref):
                handle = h; break
        if handle is None:
            handle = 'unassigned'

    variant = p['variants'][0] if p['variants'] else {}
    images = []
    for im in p['images']:
        m = master_img(im['src'])
        if 'IMAGECOMINGSOON' in m:
            continue
        if m not in images:
            images.append(m)

    species = spec.get('SPECIES')
    construction = infer_construction(species, spec.get('THICKNESS'), p['tags'], spec.get('BACKING'))

    rec = OrderedDict([
        ('name', p['title']),
        ('handle', p['handle']),
        ('species', species),
        ('construction', construction),
        ('width', spec.get('WIDTH')),
        ('length', spec.get('LENGTH')),
        ('thickness', spec.get('THICKNESS')),
        ('wear_layer', spec.get('TOP LAYER')),
        ('finish', spec.get('FINISH')),
        ('texture', spec.get('TEXTURE')),
        ('edge', spec.get('EDGE')),
        ('grade', spec.get('GRADE')),
        ('sheen', spec.get('SHEEN')),
        ('treatment', spec.get('TREATMENT')),
        ('backing', spec.get('BACKING')),
        ('sku', variant.get('sku')),
        ('tags', p['tags']),
        ('product_type', p['product_type']),
        ('images', images),
    ])
    get_col(handle)['products'].append(rec)

# collections that returned 0 but exist on site (empty / discontinued lines)
failed = []
for h, title in colmeta.items():
    if h in META: continue
    n = len(mem.get_dummy) if False else None
    # a collection endpoint fetched with 0 products
    fpath = os.path.join(BASE,'cols',h+'.json')
    if os.path.exists(fpath):
        cnt = len(json.load(open(fpath)).get('products',[]))
        if cnt == 0:
            failed.append({'handle': h, 'name': title, 'reason': 'endpoint returned 0 products (empty/discontinued line)'})

out = OrderedDict()
out['collections'] = list(collections.values())
out['collections_failed'] = failed
out['notes'] = (
    "Source: rewardflooring.com Shopify JSON endpoints (products.json + per-collection products.json), fetched 2026-08-14. "
    "products.json returned 106 products total on a single page (page 2 empty). ALL 106 have product_type='Hardwood'. "
    "The live Reward catalog is entirely HARDWOOD: 100 engineered hardwood + 6 solid (the 'Heritage' line, tagged 'Solid'). "
    "NO SPC / rigid-core / waterproof / LVT / laminate products are live: collections like Gemcore, Duracork, Luxury Vinyl, LVT, "
    "and the GemCore tile lines (Earth, Onyx, Jade, Ruby, Sapphire, Emerald, Topaz, Napa, Meridian, Majesty, etc.) all return 0 "
    "products via their collection endpoints (listed in collections_failed) - these appear to be discontinued/emptied SPC & tile lines. "
    "The 'Heritage' collection has no collection endpoint; its 6 products were assigned by title prefix + 'Solid' tag. "
    "Specs parsed from body_html spec list (SPECIES/THICKNESS/WIDTH/LENGTH/TOP LAYER=wear layer/TEXTURE/GRADE/BACKING/FINISH/SHEEN/TREATMENT/EDGE). "
    "EDGE present on only 9 products; no explicit INSTALLATION or GLOSS field (SHEEN carries gloss info). "
    "Variant prices are all 0.00 (call-for-pricing / trade). Image URLs normalized to master (stripped ?v= and _NNNx size suffixes); "
    "IMAGECOMINGSOON placeholder images dropped."
)

json.dump(out, open(os.path.join(BASE,'reward-public-raw.json'),'w'), indent=2, ensure_ascii=False)

# ---- report ----
total = sum(len(c['products']) for c in out['collections'])
print('TOTAL products written:', total)
print('products.json count    :', len(prods))
print('all handles covered    :', all_handles_seen == {p['handle'] for c in out['collections'] for p in c['products']})
print()
print('PER-COLLECTION:')
hw=solid=eng=other=0
for c in out['collections']:
    cons=set(p['construction'] for p in c['products'])
    print(f"  {len(c['products']):3d}  {c['name']:22s} [{c['handle']}]  ({','.join(sorted(cons))})")
for c in out['collections']:
    for p in c['products']:
        if p['construction']=='solid': solid+=1
        elif p['construction']=='engineered': eng+=1
        else: other+=1
print()
print(f'engineered hardwood: {eng}   solid hardwood: {solid}   other/SPC: {other}')
print('empty (failed) collections:', len(failed))
print()
# missing spec fields site-wide
miss={}
for c in out['collections']:
    for p in c['products']:
        for k in ['species','width','length','thickness','wear_layer','finish','texture','edge','grade']:
            if not p.get(k): miss[k]=miss.get(k,0)+1
print('Missing spec counts (of', total, 'products):', miss)
