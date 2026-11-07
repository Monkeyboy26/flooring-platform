#!/usr/bin/env python3
"""Parse Mannington dealer price-update PDFs (Acct 80985, eff 2026-11-06) into JSON.

Cartons PDF: series blocks (LVT/laminate/wood). Each block:
  - series header line:  "SERIES NAME (CODE) ... Warranty: ..."
  - column header line:  "... Catalog # SQ.Ft. ... Profile  $25.36 $23.71 ..." (trim per-piece prices)
  - data rows: Pattern Width ColorDesc ColorCode Catalog# $sqft $carton ... profile trimCat trimCat ...
Trim catalogs map to the trim price whose header x-center is nearest.

Rolls PDF: sheet vinyl rows: Pattern ColorDesc Catalog# StyleCode ColorCode Size $roll [$cut]
"""
import json, re, sys
import pdfplumber

MONEY = re.compile(r'^\$[\d,]+\.\d{2}$')
CATALOG = re.compile(r'^\d{5,7}$')

def money(tok):
    return float(tok.replace('$', '').replace(',', ''))

def group_lines(words, tol=3.0):
    lines = []
    for w in sorted(words, key=lambda w: (w['top'], w['x0'])):
        if lines and abs(w['top'] - lines[-1][0]['top']) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(l, key=lambda w: w['x0']) for l in lines]

def parse_cartons(path):
    fields, trims, conflicts = [], {}, []
    series = series_code = section = None
    trim_cols = []   # list of (x_center, price, label) for current block
    with pdfplumber.open(path) as pdf:
        for pageno, page in enumerate(pdf.pages, 1):
            words = page.extract_words()
            prev_lines = []
            for line in group_lines(words):
                toks = [w['text'] for w in line]
                text = ' '.join(toks)
                m = re.match(r'^(.*?)\(([A-Z0-9]{2,6})\)', text)
                if m and 'Warranty:' in text:
                    series, series_code = m.group(1).strip(), m.group(2)
                    trim_cols = []
                    prev_lines = []
                    continue
                if len(toks) == 1 and toks[0] in ('LVT', 'Wood', 'Laminate'):
                    section = toks[0]
                    continue
                # block column-header line: has "SQ.Ft." and the trim prices
                if 'SQ.Ft.' in toks and 'Pattern' in toks:
                    cols = [((w['x0'] + w['x1']) / 2, money(w['text']))
                            for w in line if MONEY.match(w['text'])]
                    # label each column from the wrapped header words on the
                    # preceding 1-3 lines (and this line left of the first price)
                    label_words = []
                    for pl in prev_lines[-3:]:
                        label_words.extend(pl)
                    first_price_x = min((c for c, _ in cols), default=1e9)
                    label_words.extend(w for w in line
                                       if not MONEY.match(w['text']) and (w['x0'] + w['x1']) / 2 > first_price_x - 25)
                    trim_cols = []
                    for cx, price in cols:
                        parts = sorted((w for w in label_words
                                        if abs((w['x0'] + w['x1']) / 2 - cx) <= 22),
                                       key=lambda w: (w['top'], w['x0']))
                        label = ' '.join(w['text'] for w in parts)
                        trim_cols.append((cx, price, label))
                    prev_lines = []
                    continue
                prev_lines.append(line)
                if len(prev_lines) > 4:
                    prev_lines.pop(0)
                # data row: needs >=2 money tokens (sqft + carton price)
                mny = [i for i, t in enumerate(toks) if MONEY.match(t)]
                if len(mny) < 2 or series is None:
                    continue
                i_sqft, i_carton = mny[0], mny[1]
                if i_sqft < 2:
                    continue
                catalog = toks[i_sqft - 1]
                color_code = toks[i_sqft - 2]
                if not CATALOG.match(catalog):
                    continue
                # pattern/width/colordesc = tokens before color code (not split further; width is 2nd-to-last-ish)
                desc = ' '.join(toks[:i_sqft - 2])
                rec = {
                    'section': section, 'series': series, 'series_code': series_code,
                    'desc': desc, 'color_code': color_code, 'catalog': catalog,
                    'cost_sqft': money(toks[i_sqft]), 'carton_price': money(toks[i_carton]),
                    'page': pageno, 'trims': [],
                }
                fields.append(rec)
                # trim catalogs: words AFTER the carton-price x position matching 6-7 digits,
                # mapped to nearest trim-price column center
                carton_x = line[i_carton]['x1']
                for w in line:
                    if w['x0'] <= carton_x or not re.match(r'^\d{6,7}$', w['text']):
                        continue
                    if not trim_cols:
                        continue
                    cx = (w['x0'] + w['x1']) / 2
                    col_i, (dist, price, label) = min(enumerate((abs(cx - c), p, lbl) for c, p, lbl in trim_cols), key=lambda t: t[1][0])
                    if dist > 40:  # not plausibly under a trim column
                        continue
                    if price <= 0:
                        continue
                    cat = w['text']
                    if cat in trims and abs(trims[cat]['price'] - price) > 0.005:
                        conflicts.append({'catalog': cat, 'a': trims[cat], 'b': {'price': price, 'series': series, 'page': pageno}})
                    trims[cat] = {'price': price, 'label': label, 'series': series, 'series_code': series_code, 'page': pageno}
                    rec['trims'].append({'catalog': cat, 'price': price, 'label': label, 'col': col_i})
    return fields, trims, conflicts

# 'Installation Method' FIRST: that line also contains 'Required Adhesive' —
# matching the latter would capture the installation text as a series name
SERIES_MARKERS = ('Installation Method', 'Required Seam', 'Required Adhesive', 'Seaming Options', 'Adhesive Options')

def parse_rolls(path):
    rows = []
    series = None
    pat_cx = col_cx = None  # header column centers for Pattern / Color Description
    with pdfplumber.open(path) as pdf:
        for pageno, page in enumerate(pdf.pages, 1):
            words = page.extract_words()
            for line in group_lines(words):
                toks = [w['text'] for w in line]
                text = ' '.join(toks)
                marker = next((m for m in SERIES_MARKERS if m in text), None)
                if marker:
                    head = text.split(marker)[0].strip()
                    if head:
                        series = head
                    continue
                if 'Pattern' in toks and 'Catalog' in text:
                    pat_cx = col_cx = None
                    for w in line:  # sorted by x0; first 'Color' right of Pattern = Color Description
                        cx = (w['x0'] + w['x1']) / 2
                        if w['text'] == 'Pattern':
                            pat_cx = cx
                        elif w['text'] == 'Color' and col_cx is None and pat_cx is not None:
                            col_cx = cx
                    continue
                mny = [i for i, t in enumerate(toks) if MONEY.match(t)]
                size_i = [i for i, t in enumerate(toks) if re.match(r"^\d{1,2}'$", t)]
                if not mny or not size_i:
                    # series header: a line with no money that isn't boilerplate — track loosely
                    continue
                si = size_i[-1]
                # ... Catalog# StyleCode ColorCode Size $roll [$cut]
                if si < 3:
                    continue
                catalog, style, color = toks[si - 3], toks[si - 2], toks[si - 1]
                if not CATALOG.match(catalog) and CATALOG.match(toks[si - 2]):
                    continue
                # split pattern vs color-desc by nearest header column center
                pattern_parts, color_parts = [], []
                for w in line[:si - 3]:
                    cx = (w['x0'] + w['x1']) / 2
                    if pat_cx is not None and col_cx is not None and abs(cx - col_cx) < abs(cx - pat_cx):
                        color_parts.append(w['text'])
                    else:
                        pattern_parts.append(w['text'])
                rows.append({
                    'series': series, 'pattern': ' '.join(pattern_parts).rstrip('*').strip(),
                    'color': ' '.join(color_parts), 'desc': ' '.join(toks[:si - 3]),
                    'catalog': catalog, 'style_code': style, 'color_code': color,
                    'size': toks[si], 'roll_sf': money(toks[mny[0]]),
                    'cut_sf': money(toks[mny[1]]) if len(mny) > 1 else None, 'page': pageno,
                })
    return rows

if __name__ == '__main__':
    cartons_pdf, rolls_pdf, out = sys.argv[1], sys.argv[2], sys.argv[3]
    fields, trims, conflicts = parse_cartons(cartons_pdf)
    rolls = parse_rolls(rolls_pdf)
    # field color-code conflicts (same code, different cost)
    seen, fconf = {}, []
    for f in fields:
        k = f['color_code']
        if k in seen and abs(seen[k]['cost_sqft'] - f['cost_sqft']) > 0.005:
            fconf.append({'color_code': k, 'a': seen[k], 'b': f})
        seen[k] = f
    json.dump({'fields': fields, 'trims': trims, 'rolls': rolls,
               'trim_conflicts': conflicts, 'field_conflicts': fconf}, open(out, 'w'), indent=1)
    print(f"fields={len(fields)} unique_color_codes={len(seen)} trims={len(trims)} rolls={len(rolls)}")
    print(f"trim_conflicts={len(conflicts)} field_conflicts={len(fconf)}")
