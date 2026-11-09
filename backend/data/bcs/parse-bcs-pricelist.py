# Parse the Best Cheer Stone (BCS) wholesale price list PDF -> bcs-catalog.json
# Sections: Quartz Prefab, Natural Stone Prefab, Quartz Slab, Natural Stone Slab,
# Shower Wall Panel. Item-name cells are merged across rows (carry forward).
# "Coming Soon" / "-" cells -> null. Item names carry hyperlinks (bestcheerstone.com)
# which we capture for a later image scrape.
#
#   python3 parse-bcs-pricelist.py
import json, re, os
import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, 'bcs-wholesale-pricelist-2026-09-02.pdf')


def money(cell):
    if cell is None:
        return None
    t = str(cell).replace('\n', ' ').strip()
    if not t or 'coming' in t.lower() or t == '-':
        return None
    m = re.search(r'\$?\s*([\d,]+(?:\.\d+)?)', t)
    return float(m.group(1).replace(',', '')) if m else None


def clean(cell):
    return re.sub(r'\s+', ' ', str(cell or '').replace('\n', ' ')).strip()


def row_links(page):
    """[(top, bottom, uri)] for every hyperlink rect on the page."""
    out = []
    for a in page.hyperlinks or []:
        out.append((a['top'], a['bottom'], a['uri']))
    return out


def link_for(links, row_top, row_bottom):
    for top, bottom, uri in links:
        if top < row_bottom and bottom > row_top:
            return uri
    return None


sections = {
    'Quartz Prefab Pricing': 'quartz_prefab',
    'Natural Stone Prefab Pricing': 'stone_prefab',
    'Quartz Slab Pricing': 'quartz_slab',
    'Natural Stone Slab Pricing': 'stone_slab',
    'Shower Wall Panel Pricing': 'shower_panel',
}

catalog = {v: [] for v in sections.values()}
urls = {}  # item name -> url

with pdfplumber.open(PDF) as pdf:
    for page in pdf.pages:
        text = page.extract_text() or ''
        section = next((v for k, v in sections.items() if k in text), None)
        if not section:
            continue
        links = row_links(page)
        tables = page.find_tables()
        for tbl in tables:
            rows = tbl.extract()
            cells = tbl.rows  # geometry for link mapping
            if not rows or len(rows) < 2:
                continue
            header = [clean(c).lower() for c in rows[0]]
            if 'item name' not in header[0]:
                continue
            item = None
            for ri in range(1, len(rows)):
                r = rows[ri]
                geo = cells[ri]
                name_cell = clean(r[0])
                if name_cell:
                    item = re.sub(r'\*+$', '', name_cell).strip()
                    item = re.sub(r'^\*\*', '', item).strip()
                    u = link_for(links, geo.cells[0][1] if geo.cells[0] else geo.bbox[1],
                                 geo.cells[0][3] if geo.cells[0] else geo.bbox[3])
                    if u and item not in urls:
                        urls[item] = u
                    flags = {
                        'full_body': clean(r[0]).rstrip().endswith('*') and not clean(r[0]).rstrip().endswith('**'),
                        'size_varies': clean(r[0]).startswith('**'),
                        'jumbo': '++' in clean(r[0]),
                    }
                    item = re.sub(r'\+\+$', '', item).strip()
                    cur = {'name': item, 'flags': flags, 'rows': []}
                    catalog[section].append(cur)
                if item is None:
                    continue
                catalog[section][-1]['rows'].append([clean(c) for c in r[1:]])

out = {'sections': catalog, 'urls': urls}
with open(os.path.join(HERE, 'bcs-raw.json'), 'w') as f:
    json.dump(out, f, indent=1)

for k, v in catalog.items():
    print(k, len(v), 'items')
print('urls:', len(urls))
