#!/usr/bin/env python3
"""
Match harvested stone-pride.com images (sp_images.json) to Stone Pride SKUs by the
item code embedded in the image filename, and write:
  backend/data/stone-pride/images.json      product name -> {primary, gallery}
  backend/data/stone-pride/sku-images.json   vendor_sku  -> {primary, gallery}

Matching: normalize both the vendor_sku (finish/grade stripped -> pattern key) and
the filename; assign each image to the SKU-group whose pattern key is the LONGEST
prefix of the filename (kills short-code over-matching); an image is shared across
all finishes of that pattern. Product hero = first matched SKU image, else the
per-stone overview swatch.

Run: python3 backend/scripts/match-stone-pride-images.py
"""
import json, re, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(ROOT, "backend", "data", "stone-pride")
IMG_JSON = os.environ.get("SP_IMG_OUT", "/private/tmp/claude-501/-Users-kianassarpour-Desktop-flooring-platform/99f40623-9d8d-48e9-a4bb-572cf664f98b/scratchpad/sp_images.json")

catalog = json.load(open(os.path.join(DATA, "catalog.json")))
images = json.load(open(IMG_JSON))

# ---- normalization: unify the site's descriptive vocab with the price-list codes
VOCAB = [
    (r'hexagon', 'hex'), (r'herringbone', 'herring'), (r'beveled|bevelled', 'bevel'),
    (r'octagon', 'oct'), (r'elongated', 'long'), (r'chevron', 'chev'),
    (r'rhomboid', 'rhomb'), (r'basketweave|basket', 'basket'),
    (r'pennyround|penny', 'penny'), (r'subway', ''), (r'polished', 'p'),
    (r'honed', 'h'), (r'tumbled', 't'), (r'brick', 'brick'), (r'random', 'random'),
    (r'strip', 'strip'), (r'morocco', 'moroc'), (r'marble|mosaic|pattern|available|design', ''),
]
def norm(s):
    s = s.lower()
    s = re.sub(r'\.(jpg|jpeg|png)$', '', s)
    for pat, rep in VOCAB:
        s = re.sub(pat, rep, s)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s

def strip_finish(code):
    c = re.sub(r'(\([^)]*\))+', '', code)        # (D)(A+)(GRN)...
    c = re.sub(r'[-\s]\d+mm$', '', c)             # thickness
    c = re.sub(r'[-\s](H|P|T)$', '', c)           # finish
    c = re.sub(r'[-\s](H|P|T)$', '', c)
    return c.strip(' -')

def sku_finish(code):
    m = re.search(r'-(H|P|T)(?:\b|\(|$)', code)
    return {'H':'h','P':'p','T':'t'}.get(m.group(1)) if m else None

MIN = 6  # minimum pattern-key length to accept a match (avoid stone-code-only hits)

# pattern key -> list of (vendor_sku, product_name, finish)
pkey_group = defaultdict(list)
sku_meta = {}
for p in catalog:
    for s in p["skus"]:
        vs = s["vendor_sku"]
        pk = norm(strip_finish(vs))
        sku_meta[vs] = {"pk": pk, "finish": sku_finish(vs), "product": p["name"]}
        if len(pk) >= MIN:
            pkey_group[pk].append(vs)

# sort pattern keys longest first for greedy longest-prefix assignment
pkeys_sorted = sorted(pkey_group.keys(), key=len, reverse=True)

# ---- per-stone overview swatches (filename = <STONECODE>-<Name>, no MS/Tile prefix)
STONE_SWATCH = {}
swatch_re = re.compile(r'^(CW|CM|CG|TW|AR|ARdb|BM|BA|BG|BL|ED|EL|EM|HO|RA|HB|HD|NB|NC|NP|TB|GW)[-_]', re.I)
for im in images:
    fn = im["filename"]
    if swatch_re.match(fn) and not re.match(r'^(MS|Tile|MM|ML|MSL|FR)', fn, re.I):
        code = swatch_re.match(fn).group(1).upper()
        STONE_SWATCH.setdefault(code, im["url"])
# a representative terrazzo image for the lumped Terrazzo Tile/Mosaic products
for im in images:
    if re.match(r'terrazzo', im["filename"], re.I) and re.search(r'hex|24x24|12x24|blue|gold|silver', im["filename"], re.I):
        STONE_SWATCH.setdefault("TERRAZZO", im["url"]); break
# blends/variants borrow the base stone's representative swatch (same look family)
SWATCH_ALIAS = {"ARDB":"AR","AR(NEW)":"AR","CONT.CG":"CG","CGBY":"CG","CWBM":"CW",
                "CWBY":"CW","CWTW":"CW","CWSS":"CW","CMED":"CM","EDEL":"ED","TWBI":"TW","TWBY":"TW"}
def swatch_for(code):
    if not code: return None
    c = code.upper()
    return STONE_SWATCH.get(c) or STONE_SWATCH.get(SWATCH_ALIAS.get(c, ""))

def img_full_pref(url):
    # prefer the plain (non-thumbnail) full-size; crawler already stripped -WxH
    return url

# ---- assign images to SKUs
sku_imgs = defaultdict(list)   # vendor_sku -> [urls]
matched_imgs = 0
for im in images:
    fk = norm(im["filename"])
    # find longest pattern key that prefixes this filename
    hit = None
    for pk in pkeys_sorted:
        if fk.startswith(pk):
            hit = pk; break
    if not hit:
        continue
    matched_imgs += 1
    imf = re.sub(r'\.(jpg|jpeg|png)$', '', im["filename"]).lower()
    im_fin = 'p' if re.search(r'polish', imf) else ('h' if re.search(r'hone', imf) else ('t' if re.search(r'tumbl', imf) else None))
    for vs in pkey_group[hit]:
        # if the image declares a finish and the sku finish differs AND the image is
        # finish-specific (not "available in polished and honed"), still attach as gallery
        sku_imgs[vs].append((im["url"], im_fin))

# ---- build outputs
sku_out = {}
for vs, lst in sku_imgs.items():
    fin = sku_meta[vs]["finish"]
    # primary: prefer an image whose finish matches the sku's finish, else first
    ordered = sorted(lst, key=lambda t: (0 if (t[1] == fin or t[1] is None) else 1))
    urls = []
    for u, _ in ordered:
        if u not in urls: urls.append(u)
    sku_out[vs] = {"primary": urls[0], "gallery": urls[1:6]}

# stone code for a product (from its first sku's vendor_sku prefix) for swatch fallback
def stone_code_of(product):
    for s in product["skus"]:
        vs = s["vendor_sku"]
        if vs.startswith("SP-Terrazzo") or "Terrazzo" in vs:
            return "TERRAZZO"
        m = re.match(r'(?:MS|Tile|FR)-([A-Za-z().]+?)(?:-|\d)', vs)
        if m:
            return re.sub(r'\(.*$', '', m.group(1)).strip('-').upper()   # AR(EW) -> AR
    return None

prod_out = {}
prod_with_sku_img = 0
for p in catalog:
    # hero = first sku (in catalog order) that has an image
    hero = None
    for s in p["skus"]:
        if s["vendor_sku"] in sku_out:
            hero = sku_out[s["vendor_sku"]]["primary"]; break
    if hero:
        prod_out[p["name"]] = {"primary": hero}
        prod_with_sku_img += 1
    else:
        sw = swatch_for(stone_code_of(p))
        if sw:
            prod_out[p["name"]] = {"primary": sw}

# keep the 3 self-hosted terrazzo swatches already wired (don't overwrite)
TERR = {
    "Terrazzo SP1870 Tile":  {"primary": "/uploads/stone-pride/terrazzo-sp1870.jpg"},
    "Terrazzo SP6268 Tile":  {"primary": "/uploads/stone-pride/terrazzo-sp6268.jpg"},
    "Terrazzo SP20646 Tile": {"primary": "/uploads/stone-pride/terrazzo-sp20646.jpg"},
}
prod_out.update(TERR)

# force https (storefront is https; avoid mixed-content on hotlinked vendor URLs)
def https(u): return re.sub(r'^http://', 'https://', u) if u.startswith('http://') else u
for d in (prod_out, sku_out):
    for k, v in d.items():
        if v.get("primary"): v["primary"] = https(v["primary"])
        if v.get("gallery"): v["gallery"] = [https(x) for x in v["gallery"]]

json.dump(prod_out, open(os.path.join(DATA, "images.json"), "w"), indent=1)
json.dump(sku_out, open(os.path.join(DATA, "sku-images.json"), "w"), indent=1)

nsku = sum(len(p["skus"]) for p in catalog)
print(f"Harvested images: {len(images)}   matched-to-SKU events: {matched_imgs}")
print(f"SKUs with an image:     {len(sku_out)} / {nsku}")
print(f"Products with a hero:   {len(prod_out)} / {len(catalog)}  ({prod_with_sku_img} from a SKU photo, rest swatch/terrazzo)")
print(f"Stone overview swatches found: {sorted(STONE_SWATCH.keys())}")
# sample
print("\nSample SKU matches:")
for vs in list(sku_out)[:8]:
    print(f"   {vs:34s} -> {sku_out[vs]['primary'].rsplit('/',1)[-1]}")
