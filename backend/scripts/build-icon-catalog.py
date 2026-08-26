#!/usr/bin/env python3
"""
Build Icon Tile catalog.json from the 2026 GENERAL PRICELIST.xlsx.

Icon Tile (Los Angeles) is a natural-stone + porcelain hardscape distributor with its
own quarries: travertine/limestone/marble/granite/sandstone pavers & pool copings,
porcelain pavers, split-face/rock-face ledger panels, mosaics, field tiles, wall caps,
liners and freeform walling.

The pricelist "Unit price" column is Icon's dealer price = Roma's COST.
Retail = nearestNine(cost x 1.6) — store-standard keystone + charm pricing (base.js).
(All Icon costs are >= ~$3, so cost x 1.6 always clears the cost+$0.99 covering floor;
the floor never binds, so a plain nine-ending of the keystone matches the store rule.)

Selling model (per [[selling-conventions]] / [[natural-stone-per-piece]]):
  Sold By SF / Square Footage / SF (x/PC)  -> sell_by='box',  price_basis='per_sqft'   (coverage calc)
  everything else (PIECE/BOX/FULL BOX/      -> sell_by='unit', price_basis='per_unit'   (per piece / per sheet)
    LINEAL FEET/Each·Sheet)                    copings, steps, ledger panels, mosaics, trim, walling corners

Output: backend/data/icon/catalog.json  (list of products, each with skus[])
Usage:  python3 backend/scripts/build-icon-catalog.py
"""
import zipfile, xml.etree.ElementTree as ET, re, json, os, math, collections

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data', 'icon')
XLSX = os.path.join(DATA_DIR, '2026-general-pricelist.xlsx')
OUT = os.path.join(DATA_DIR, 'catalog.json')
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


# ---------------- xlsx read ----------------
def read_rows(path):
    z = zipfile.ZipFile(path)
    strings = [''.join(t.text or '' for t in si.iter(NS + 't'))
               for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(NS + 'si')]
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))

    def colnum(ref):
        c = re.match(r'([A-Z]+)', ref).group(1)
        n = 0
        for ch in c:
            n = n * 26 + (ord(ch) - 64)
        return n

    def norm(s):
        return re.sub(r'\s+', ' ', (s or '').replace('\xa0', ' ')).strip()

    out = []
    for r in sheet.find(NS + 'sheetData').findall(NS + 'row'):
        cells = {}
        for c in r.findall(NS + 'c'):
            v = c.find(NS + 'v')
            if v is None:
                continue
            val = strings[int(v.text)] if c.get('t') == 's' else v.text
            cells[colnum(c.get('r'))] = norm(val)
        out.append((int(r.get('r')), cells))
    return out


# ---------------- pricing (mirror base.js) ----------------
def nearest_nine(v):
    cents = round(float(v) * 100)
    k = round((cents - 9) / 10 - 1e-9)
    return max(9, k * 10 + 9) / 100.0


def retail_from_cost(cost):
    # keystone 1.6x then charm-round to a 9-ending; covering floor never binds here
    return round(nearest_nine(cost * 1.6), 2)


# ---------------- classification ----------------
MATERIALS = [
    ('PORCELAIN', 'Porcelain'), ('POECELAIN', 'Porcelain'),  # POECELAIN = source typo
    ('CERAMIC', 'Ceramic'),
    ('TRAVERTINE', 'Travertine'), ('LIMESTONE', 'Limestone'),
    ('SANDSTONE', 'Sandstone'), ('SAND STONE', 'Sandstone'), ('MARBLE', 'Marble'),
    ('GRANITE', 'Granite'), ('QUARTZITE', 'Quartzite'), ('SLATE', 'Slate'), ('BASALT', 'Basalt'),
]


def detect_material(*texts):
    blob = ' '.join(t.upper() for t in texts if t)
    for key, label in MATERIALS:
        if key in blob:
            return label
    return None


def title_case(s):
    # Capitalize the first LETTER of each space-separated word, lower the rest — unicode-aware
    # so accented names stay intact ("CRÈME" -> "Crème", not the old "CrèMe"; "(SCABOS)" -> "(Scabos)").
    s = re.sub(r'\s+', ' ', (s or '')).strip()

    def cap(w):
        m = re.search(r'[^\W\d_]', w)   # first alphabetic char (unicode)
        if not m:
            return w
        i = m.start()
        return w[:i] + w[i].upper() + w[i + 1:].lower()

    out = ' '.join(cap(w) for w in s.split(' '))
    out = re.sub(r'\b(And|Of|The)\b', lambda m: m.group(1).lower(), out)
    return out.strip()


def strip_material_paren(s):
    """Drop a leading material parenthetical, e.g. '(Slate) Wall Cap' -> 'Wall Cap'
    (but keep descriptive parens like 'Leather (Sandblasted & Brushed)')."""
    return re.sub(r'^\(\s*(?:slate|quartzite|limestone|marble|travertine|granite|sandstone|porcelain|ceramic)\s*\)\s*',
                  '', s or '', flags=re.I).strip()


def clean_pattern(s):
    """Turn a laid-pattern 'size' (VERSAILLES / ROMAN / French) into a clean label."""
    s = re.sub(r'\(\s*FRENCH\s*\)\s*', 'French ', s or '', flags=re.I)
    s = re.sub(r'\s*[xX×]\s*[\d/.]+\s*"?.*$', '', s)   # strip trailing thickness "X 1.25\""
    s = title_case(s.strip())
    if s and 'PATTERN' not in s.upper():
        s += ' Pattern'
    return s


def clean_color(type_str, material_label):
    """Strip the material word(s) & parentheticals-that-are-just-material from the type."""
    s = type_str
    # remove parenthetical that is purely a material name e.g. (TRAVERTINE), (LIMESTONE), (GRANITE)
    s = re.sub(r'\(\s*(TRAVERTINE|LIMESTONE|MARBLE|GRANITE|SANDSTONE|SAND STONE|PORCELAIN|POECELAIN|CERAMIC|QUARTZITE|SLATE)\s*\)',
               '', s, flags=re.I)
    # remove trailing/standalone material words
    s = re.sub(r'\b(TRAVERTINE|LIMESTONE|MARBLE|GRANITE|SANDSTONE|SAND STONE|PORCELAIN|POECELAIN|CERAMIC|QUARTZITE|SLATE)\b',
               '', s, flags=re.I)
    s = re.sub(r'(?<=[A-Za-z])\(', ' (', s)   # "Indian(Lime)" -> "Indian (Lime)"
    s = re.sub(r'\s+', ' ', s).strip(' -')
    s = fix_color_spelling(s)
    return title_case(s) if s else (material_label or 'Natural Stone')


# Vendor pricelist misspells a few stone/color names; correct them for customer display
# (vendor_sku on the PO is untouched, so ordering still matches). Applied case-insensitively
# before title_case. Order matters: the phrase fix reorders "White Carrera" -> "Carrara White".
COLOR_SPELLING = [
    (r'\bWhite\s+Carrera\s+Splitface\b', 'Carrara White Splitface'),
    (r'\bCalcatta\b',                    'Calacatta'),
    (r'\bCapuccino\b',                   'Cappuccino'),
]
def fix_color_spelling(s):
    for pat, repl in COLOR_SPELLING:
        s = re.sub(pat, repl, s, flags=re.I)
    return s


# family -> (label, category_slug)
def classify(desc, sold_by, type_str, finish, vendor_sku=''):
    d = (desc or '').upper()
    sb = (sold_by or '').upper()
    is_area = sb.startswith('SF') or sb == 'SQUARE FOOTAGE'
    prefix = re.match(r'[A-Z]+', vendor_sku or '')
    prefix = prefix.group(0) if prefix else ''

    # Ledger / rock-face panels are always identified by their SKU prefix — this
    # catches the honed/polished/3D/2D wall-panel rows whose FORM column reads
    # HONED/POLISHED/NATURAL rather than "SPLIT FACE".
    if prefix in ('LP', 'LPC', 'RF', 'RFC'):
        fam, cat = 'ledger', 'stacked-stone'
        return fam, cat, ('box' if is_area else 'unit'), ('per_sqft' if is_area else 'per_unit')

    if 'COPING' in d:
        fam, cat = 'coping', 'pool-coping'
    elif 'STEP' in d or 'QUARTER ROUND' in d:
        fam, cat = 'coping', 'pool-coping'
    elif 'SPLIT FACE' in d or 'ROCK FACE' in d or 'ROCKFACE' in d and 'WALLING' not in d:
        fam, cat = 'ledger', 'stacked-stone'
    elif 'MOSAIC' in d:
        fam, cat = 'mosaic', 'mosaic-tile'
    elif 'WALLING' in d or 'FLAGSTONE' in d or 'PEBBLE' in d:
        fam, cat = 'walling', 'hardscaping'
    elif 'WALL CAP' in (finish or '').upper() or 'COLUMN CAP' in (finish or '').upper() \
            or 'WAINSCOT' in (finish or '').upper() or 'CAP' in d:
        fam, cat = 'cap', 'hardscaping'
    elif 'PAVER' in d:
        fam, cat = 'paver', 'pavers'
    elif any(k in d for k in ('PENCIL', 'LINER', 'ROPE', 'NEEDLE', 'CROWN', 'COLOSSEO')):
        fam, cat = 'trim', 'trim-accessories'
    elif 'BULLNOSE EDGE TILE' in d:
        fam, cat = 'trim', 'trim-accessories'
    elif 'BULLNOSE' in d:  # standalone bullnose / double bullnose = coping edge
        fam, cat = 'coping', 'pool-coping'
    elif any(k in d for k in ('TILE', 'NATURAL', 'HONED', 'POLISHED', 'BEVELED', 'GLAZED', 'MATTE', 'GLOSSY')):
        material = detect_material(type_str, finish, desc)
        fam = 'tile'
        cat = ('porcelain-tile' if material == 'Porcelain'
               else 'ceramic-tile' if material == 'Ceramic'
               else 'natural-stone')
    else:
        # fallback by material/area
        material = detect_material(type_str, finish, desc)
        fam = 'tile'
        cat = ('porcelain-tile' if material == 'Porcelain'
               else 'ceramic-tile' if material == 'Ceramic'
               else 'natural-stone')

    sell_by = 'box' if is_area else 'unit'
    price_basis = 'per_sqft' if is_area else 'per_unit'
    return fam, cat, sell_by, price_basis


FAM_LABEL = {
    'paver': 'Pavers', 'coping': 'Pool Coping', 'ledger': 'Ledger Panel',
    'mosaic': 'Mosaic', 'tile': 'Tile', 'walling': 'Walling', 'trim': 'Trim', 'cap': 'Wall & Column Caps',
}

FAM_DESC = {
    'paver': 'natural-stone pavers for patios, pool decks, driveways and walkways',
    'coping': 'pool coping and step treads with a finished bullnose or modern edge',
    'ledger': 'split-face / rock-face stacked-stone ledger panels for feature walls',
    'mosaic': 'natural-stone mosaics on mesh for walls, floors and accents',
    'tile': 'natural-stone field tiles for floors and walls',
    'walling': 'freeform rock-face walling and hardscape stone',
    'trim': 'stone trim, liners and pencil moldings',
    'cap': 'stone wall caps, column caps and wainscot sills',
}


# ---------------- size / thickness helpers ----------------
def clean_size(size):
    s = (size or '').strip()
    s = s.replace('  ', ' ')
    # normalize "6 X 12 X 1.25\"" -> "6x12", capture thickness separately
    return s


def _is_dim(t):
    return bool(re.match(r'^\d+(\.\d+)?$', t.strip()))


def split_size(size):
    """Split a raw size into (WxH[+shape], thickness). Feeds separate storefront pill
    axes: the WxH becomes the Size pill; the trailing thickness (1.25"/2"/3/8 …) becomes a
    Thickness pill. Copings especially need this — same WxH exists at 3cm (1.25") and 5cm (2").
    A trailing shape word is kept on the WxH ("2 X 2 HEXAGON" -> "2x2 Hexagon")."""
    s = re.sub(r'\s+', ' ', (size or '')).strip()
    dim = r'(\d+(?:\.\d+)?|\d+/\d+)"?'                              # whole/decimal/fraction inch
    m = re.match(r'^\s*' + dim + r'\s*[xX×]\s*' + dim +            # W x H
                 r'(?:\s*[xX×]\s*([\d/.]+)\s*"?)?'                   # optional thickness
                 r'\s*(.*)$', s)                                    # optional trailing shape word
    if m:
        w, h, th, rest = m.groups()
        wxh = f"{w}x{h}"
        extra = title_case(re.sub(r'["\-]', ' ', rest or '').strip())
        if extra:
            wxh = f"{wxh} {extra}"
        return wxh, th
    return s, None


def piece_sqft(wxh):
    """Area (sqft) of ONE rectangular piece from a clean 'WxH' token (inches).
    Returns None for patterns / non-rectangular / zero sizes — those stay coverage-sold."""
    m = re.match(r'^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)', wxh or '', re.I)
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    if w <= 0 or h <= 0:
        return None
    return round(w * h / 144.0, 4)


def clean_thickness(t):
    if not t:
        return None
    t = t.strip()
    # decimals/whole inches get a closing quote; fractions (3/8, 1/2) get an inch mark too
    if re.match(r'^\d+(\.\d+)?$', t):
        return t + '"'
    if re.match(r'^\d+/\d+$', t):
        return t + '"'
    return t


# Edge profile for pool coping — the axis buried in the FORM column (Bullnose vs Modern vs
# Double …). Exposed as its own storefront pill so grouped copings are selectable.
def coping_profile(desc):
    d = (desc or '').upper()
    if 'DOUBLE BULLNOSE' in d: return 'Double Bullnose'
    if 'DOUBLE MODERN' in d: return 'Double Modern'
    if '4' in d and 'MODERN' in d: return '4-Sided Modern'
    if 'MODERN' in d: return 'Modern'
    if 'BULLNOSE' in d: return 'Bullnose'
    if 'SINGLE STEP' in d: return 'Single Step'
    if 'DOUBLE STEP' in d: return 'Double Step'
    if 'QUARTER ROUND' in d: return 'Quarter Round'
    if 'CROWN' in d: return 'Crown'
    if 'STEP' in d: return 'Step'
    return title_case(desc)


def size_dims(size):
    """Return WxH numeric pair (inches) if the size looks rectangular, else None."""
    m = re.findall(r'(\d+(?:\.\d+)?)', size or '')
    nums = [float(x) for x in m]
    # drop a trailing thickness like 1.25 / .375 etc if 3 numbers
    if len(nums) >= 2:
        return nums[0], nums[1]
    return None


def is_prod(pn):
    return bool(re.match(r'^[A-Z]{1,3}\d', pn or '')) and any(ch.isdigit() for ch in pn)


# ---------------- build ----------------
def main():
    rows = read_rows(XLSX)
    products = collections.OrderedDict()  # key -> product dict
    stats = collections.Counter()
    skipped = []

    for rn, c in rows:
        pn = c.get(1, '')
        if not is_prod(pn):
            continue
        try:
            cost = float(c.get(6, ''))
        except (ValueError, TypeError):
            continue
        if cost <= 0:
            continue

        type_str = c.get(2, '')
        size = c.get(3, '')
        desc = c.get(4, '')      # FORM (PAVER/COPING/MOSAIC/...)
        finish = c.get(5, '')
        sold_by = c.get(7, '')
        weight = c.get(8, '')
        sf_pallet = c.get(9, '')

        material = detect_material(type_str, finish, desc) or 'Natural Stone'
        color = clean_color(type_str, material)
        fam, cat, sell_by, price_basis = classify(desc, sold_by, type_str, finish, pn)
        stats[cat] += 1

        fam_label = FAM_LABEL[fam]
        # product name: "<Color> <Material> <FamilyLabel>"
        pname_parts = [color]
        if material and material.lower() not in color.lower():
            pname_parts.append(material)
        pname_parts.append(fam_label)
        pname = ' '.join(pname_parts)
        collection = f"{material} {fam_label}"

        key = (pname.lower())
        if key not in products:
            products[key] = {
                'name': pname,
                'collection': collection,
                'category_slug': cat,
                'brand_name': 'Icon Tile',
                'color': color,
                'material': material,
                'form': fam,
                # NB: vendor is hidden ([[hide-public-brand]]) — description must NOT name Icon Tile.
                'description': f"{color} {material} — {FAM_DESC[fam]}.",
                'attrs': {
                    'color': color,
                    'material': material.lower(),
                },
                'skus': [],
            }

        # Size split into a clean WxH + thickness so the storefront renders them as separate
        # pill axes (a 12x24 coping exists at both 1.25" and 2"). Profile pill for copings.
        GENERIC_FORMS = {'PAVER', 'TILE', 'NATURAL', 'MOSAIC', 'R10-MOSAIC', 'R10-TILE',
                         'FREEFORM ROCKFACE WALLING'}
        SKIP_FINISH = {'TUMBLED', 'MESH BACK', 'METAL MESH BACK', ''}
        wxh, thick = split_size(size)
        thick_c = clean_thickness(thick)
        finish_t = title_case(finish) if finish else ''
        prof = coping_profile(desc) if fam == 'coping' else None

        # --- clean variant_name: "<size> <descriptor>, <finish>" (+ thickness for coping).
        # A single SPACE after the size + COMMAS between descriptors — the storefront title
        # composer turns "12x24 Bullnose" into "12″ × 24″, Bullnose" (storefront.jsx ~1342),
        # so using a dash here would read "12″ × 24″, — Bullnose". Standalone (line items) it
        # reads "12x24 Bullnose (2")" too. ---
        if fam == 'walling':
            disp = 'Freeform'
        elif re.match(r'^\d', wxh or ''):
            disp = wxh                      # dimensional & storefront-parseable, e.g. "12x24"
        else:
            disp = clean_pattern(size)      # French / Roman / Versailles laid pattern

        # form-specific distinguishing descriptor
        if fam == 'coping':
            desc_seg = prof
        elif fam == 'cap':
            desc_seg = strip_material_paren(finish_t)          # cap type lives in the finish col
        elif fam == 'walling':
            desc_seg = 'Corner' if 'CORNER' in (desc or '').upper() else None
        elif desc and desc.upper() not in GENERIC_FORMS:
            desc_seg = title_case(desc)                        # ledger texture / trim type / etc.
        else:
            desc_seg = None
        descriptors = [desc_seg] if desc_seg else []

        # finish — skip boilerplate, the material-as-finish (walling), caps (already used above),
        # and anything already shown as the descriptor.
        if fam != 'cap' and finish and finish.upper() not in SKIP_FINISH:
            ft = strip_material_paren(finish_t)
            if ft and ft.lower() != (material or '').lower() and ft.lower() != (desc_seg or '').lower():
                descriptors.append(ft)

        vname = disp or pname
        if descriptors:
            vname = f"{vname} {', '.join(descriptors)}" if disp else ', '.join(descriptors)
        if fam == 'coping' and thick_c:
            vname += f' ({thick_c})'

        # Per-piece selling (like natural stone): pavers & field tile with a clean
        # rectangular size are ordered BY THE PIECE, not by coverage. Flip sell_by to
        # 'unit' and attach the single-piece area; price_basis stays 'per_sqft' so the
        # storefront computes piece price = per-sqft rate × piece area (storefront.jsx
        # displayPrice / cart.js — see [[natural-stone-per-piece]]). Laid PATTERNS
        # (Versailles/Roman) and non-rectangular sizes keep coverage selling ('box').
        piece_area = None
        if fam in ('paver', 'tile') and sell_by == 'box' and re.match(r'^\d', disp or ''):
            piece_area = piece_sqft(wxh)
            if piece_area:
                sell_by = 'unit'

        sku = {
            'vendor_sku': pn,
            'internal_sku': f"ICON-{pn}",
            'variant_name': vname,
            'sell_by': sell_by,
            'price_basis': price_basis,
            'cost': round(cost, 2),
            'retail': retail_from_cost(cost),
            'attrs': {},
        }
        if piece_area:
            sku['packaging'] = {'sqft_per_box': piece_area, 'pieces_per_box': 1}
        if size:
            sku['attrs']['size'] = disp
        if thick_c:
            sku['attrs']['thickness'] = thick_c
        if prof:
            sku['attrs']['profile'] = prof
        if finish:
            sku['attrs']['finish'] = finish_t
        if weight:
            sku['attrs']['weight'] = weight
        if sf_pallet and sf_pallet.upper() not in ('N/A',):
            sku['attrs']['sf_per_pallet'] = sf_pallet
        sku['attrs']['sold_by'] = sold_by

        products[key]['skus'].append(sku)

    catalog = list(products.values())
    # de-dup skus by internal_sku within a product (safety)
    for p in catalog:
        seen = {}
        for s in p['skus']:
            seen[s['internal_sku']] = s
        p['skus'] = list(seen.values())

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(catalog, f, indent=1)

    nsku = sum(len(p['skus']) for p in catalog)
    print(f"Products: {len(catalog)}   SKUs: {nsku}")
    print("Category distribution:")
    for cat, n in stats.most_common():
        print(f"  {n:4}  {cat}")
    print(f"\nWrote {OUT}")


if __name__ == '__main__':
    main()
