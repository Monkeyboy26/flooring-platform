import json, re, html

d = json.load(open('products-p1.json'))['products']

# Collection metadata: handle -> (display name, family, eir?)
COLL = {
    'Garnet':    ('Garnet',       'garnet',              'SPC'),
    'Opal':      ('Opal',         'opal-collection',     'SPC'),
    'Crystal':   ('Crystal',      'crystal-1',           'SPC'),
    'Diamond':   ('Diamond',      'diamond',             'SPC'),
    'Jasper':    ('Jasper',       'jasper',              'SPC'),   # EIR
    'Sapphire':  ('Sapphire',     'sapphire-collection', 'SPC'),
    'Meridian':  ('Meridian II',  'meridian-ii',         'LVT'),
    'Advantage': ('Advantage II', 'advantage-ii',        'LVT'),
}

def clean(s):
    if s is None: return None
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = s.strip(' .')
    return s or None

def text_of_specs(body):
    # isolate tab1 (Specifications) region for the dimension line, but search whole body for robustness
    return body

def grab(body, label):
    # label followed by ':' then value up to next uppercase label or tag/newline
    m = re.search(label + r'\s*:\s*(.*?)(?=(?:[A-Z][A-Z ]{2,}:)|</li>|<li|</ol>|\Z)', body, re.S)
    return clean(m.group(1)) if m else None

def parse_dims(body):
    thickness = width = length = None
    mt = re.search(r'THICKNESS\s*:\s*([\d.]+\s*mm)', body, re.I)
    if mt: thickness = mt.group(1).replace(' ', '')
    mw = re.search(r'WIDTH\s*:\s*([\d\-/. ]+?")', body)
    if mw: width = mw.group(1).strip()
    ml = re.search(r'LENGTH\s*:\s*([\d\-/. ]+?")', body)
    if ml: length = ml.group(1).strip()
    return thickness, width, length

def parse_install(body):
    m = re.search(r'Install Method\s*:\s*(.*?)(?=</li>|<li|\Z)', body, re.S)
    return clean(m.group(1)) if m else None

def parse_wear(top):
    if not top: return None
    m = re.search(r'([\d.]+\s*mil)', top, re.I)
    return m.group(1).replace(' ', '') if m else top

def strip_img(src):
    src = re.sub(r'\?v=\d+', '', src)
    src = re.sub(r'_\d+x\d+(?=\.\w+$)', '', src)  # _100x100
    src = re.sub(r'_\d+x(?=\.\w+$)', '', src)      # _400x
    src = re.sub(r'_x\d+(?=\.\w+$)', '', src)
    return src

collections = {}
for prefix, (name, handle, fam) in COLL.items():
    collections[handle] = {'name': name, 'handle': handle, 'family': fam, 'products': []}

seen = set()
for p in d:
    if p['product_type'] not in ('Stone Composite Flooring', 'LVT'):
        continue
    prefix = p['title'].split()[0]
    if prefix not in COLL:
        raise SystemExit('unmapped prefix: ' + p['title'])
    name, chandle, fam = COLL[prefix]
    body = p['body_html']
    thickness, width, length = parse_dims(body)
    top = grab(body, 'TOP LAYER')
    grade = grab(body, 'GRADE')          # core description
    backing = grab(body, 'BACKING')      # attached pad (SPC)
    finish = grab(body, 'FINISH')
    texture = grab(body, 'TEXTURE')
    sheen = grab(body, 'SHEEN')
    ptype = grab(body, 'PRODUCT TYPE') or grab(body, 'SPECIES')
    install = parse_install(body)

    # construction classification
    if fam == 'SPC':
        construction = 'SPC / Rigid Stone Composite (plank)'
    else:
        construction = 'LVT / Glue-Down Dryback (plank)'

    # EIR flag from tags/texture
    eir = 'EIR' in p['tags'] or (texture and 'EIR' in texture.upper()) or bool(re.search(r'\bEIR\b', body))

    sku = None
    for v in p['variants']:
        if v.get('sku'):
            sku = v['sku']; break

    imgs = []
    for im in p['images']:
        s = strip_img(im['src'])
        if s not in imgs:
            imgs.append(s)

    rec = {
        'name': p['title'],
        'handle': p['handle'],
        'product_type': p['product_type'],
        'family': fam,
        'construction': construction,
        'thickness': thickness,
        'width': width,
        'length': length,
        'wear_layer': parse_wear(top),
        'core': grade,                    # e.g. "Stone Composite Flooring (SCF) - over 70% stone"
        'finish': finish,
        'sheen': sheen,
        'texture': texture,
        'eir': eir,
        'edge': None,                     # not in JSON body for these; see notes
        'attached_pad': backing,          # SPC EVA/IXPE pad; None for LVT dryback
        'install_method': install,
        'waterproof': True,
        'sku': sku,
        'tags': p['tags'],
        'images': imgs,
    }
    collections[chandle]['products'].append(rec)
    seen.add(p['handle'])

out = {
    'collections': [collections[COLL[k][1]] for k in ['Garnet','Opal','Crystal','Diamond','Jasper','Sapphire','Meridian','Advantage']],
    'collections_failed': [
        {'handle': 'onyx',  'reason': 'collections/onyx endpoint returned 0 products; no Onyx-titled products in products.json (not published)'},
        {'handle': 'teton', 'reason': 'endpoint returned 0 products (empty/unpublished; not a GemCore collection)'},
        {'handle': 'yosemite', 'reason': 'endpoint returned 0 products (empty/unpublished; not a GemCore collection)'},
        {'handle': 'topaz', 'reason': 'no such collection and no Topaz-titled products in public feed'},
        {'handle': 'majesty-eir', 'reason': 'no such collection and no Majesty-titled products in public feed'},
        {'handle': 'sapphire-eir', 'reason': 'Sapphire exists as plain SPC (sapphire-collection); no separate EIR variant in feed'},
    ],
    'notes': (
        'Source: gemcoreflooring.com Shopify public JSON (products.json single page, 86 products total). '
        'GemCore = 38 SPC (product_type "Stone Composite Flooring") + 18 LVT (product_type "LVT") = 56 products across 8 collections. '
        'The other 30 products are product_type "Laminate" (Reward-brand waterproof laminate collections: Riverfront, Lakeshore, Seaside, Teton, Yosemite, etc.) '
        'and are NOT GemCore -> excluded from this catalog. '
        'Missing vs task brief: Topaz, Onyx EIR, Jasper EIR (Jasper IS present, tagged EIR), Sapphire EIR, Majesty EIR are NOT in the public feed. '
        'Jasper collection is EIR-textured (see texture field). '
        'No SPC/stone TILE products exist in this feed - all GemCore products are planks. '
        'Spec fields site-wide: "edge"/bevel treatment is described only in prose Description (not the Specifications tab) so left null; '
        'LVT products have no attached_pad (dryback glue-down); "core" holds the GRADE line (stone-composite % for SPC, virgin-vinyl for LVT). '
        'Image URLs stripped of ?v= and _NNNx size suffixes.'
    ),
}

json.dump(out, open('gemcore-public-raw.json', 'w'), indent=2, ensure_ascii=False)

# cross-check
total = sum(len(c['products']) for c in out['collections'])
print('collections:', len(out['collections']))
for c in out['collections']:
    with_sku = sum(1 for p in c['products'] if p['sku'])
    with_img = sum(1 for p in c['products'] if p['images'])
    print(f"  {c['name']:14} {c['family']:3} n={len(c['products']):2} sku={with_sku} img={with_img}")
print('TOTAL gemcore products written:', total)
print('SPC:', sum(len(c['products']) for c in out['collections'] if c['family']=='SPC'))
print('LVT:', sum(len(c['products']) for c in out['collections'] if c['family']=='LVT'))
# verify every SPC/LVT product from products.json is present
srcgem = set(p['handle'] for p in d if p['product_type'] in ('Stone Composite Flooring','LVT'))
print('cross-check: source gem handles', len(srcgem), 'written', len(seen), 'missing', srcgem-seen)
