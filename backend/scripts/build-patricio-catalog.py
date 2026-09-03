#!/usr/bin/env python3
"""Stage 1: parse Patricio Q1 price-list PDF -> catalog_pdf.json (authoritative per-piece costs)."""
import pdfplumber, json, re, os
from collections import defaultdict, Counter
PDF='/Users/kianassarpour/Downloads/Patricio Tile Q-1-2025.pdf'
OUT='/Users/kianassarpour/Desktop/flooring-platform/backend/data/patricio'
os.makedirs(OUT, exist_ok=True)
pdf=pdfplumber.open(PDF)
def txt(i): return pdf.pages[i].extract_text() or ''
def slug(s): return re.sub(r'-+','-',re.sub(r'[^a-z0-9]+','-',s.lower())).strip('-')
def sqft(size):
    m=re.match(r'(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$',size); return round(float(m.group(1))*float(m.group(2))/144.0,4) if m else None
def sz_w(s):
    m=re.match(r'(\d+(?:\.\d+)?)',s); return float(m.group(1)) if m else 99
products=[]
def add(**kw): products.append(kw)

def grid_single(page_idx, sizes_order, model_re, y_lo=105, y_hi=9999):
    """Per-bullet -> nearest model in same band+row. Models are single tokens. Y-scoped."""
    pg=pdf.pages[page_idx]
    ws=[w for w in pg.extract_words(use_text_flow=False,keep_blank_chars=False) if y_lo<=w['top']<=y_hi]
    hdrs=[((w['x0']+w['x1'])/2,w['text']) for w in ws if w['text'] in sizes_order]
    xs=sorted(set(round(h[0]) for h in hdrs)); bands=[]; cur=[xs[0]]
    for x in xs[1:]:
        if x-cur[-1]>55: bands.append(cur); cur=[x]
        else: cur.append(x)
    bands.append(cur); branges=[(min(b)-72,max(b)+16) for b in bands]
    def band_of(xc):
        for i,(lo,hi) in enumerate(branges):
            if lo<=xc<=hi: return i
    def near(xc): return min(hdrs,key=lambda h:abs(h[0]-xc))[1]
    models=[w for w in ws if model_re.match(w['text'])]
    res=defaultdict(set); order=[]
    for m in sorted(models,key=lambda m:(band_of((m['x0']+m['x1'])/2) or 0,m['top'])):
        if m['text'] not in res: order.append(m['text']); res[m['text']]
    for b in [w for w in ws if w['text']=='■']:
        bt=(b['top']+b['bottom'])/2; bxc=(b['x0']+b['x1'])/2; bnd=band_of(bxc)
        cand=[m for m in models if band_of((m['x0']+m['x1'])/2)==bnd and abs(((m['top']+m['bottom'])/2)-bt)<6]
        if cand:
            m=min(cand,key=lambda m:abs(((m['top']+m['bottom'])/2)-bt)); res[m['text']].add(near(bxc))
    return [(c,res[c]) for c in order]

def grid_multi(page_idx, sizes_order, y_lo, y_hi):
    """Row-cluster; model = joined tokens left of band headers. For multiword models (solids)."""
    pg=pdf.pages[page_idx]
    ws=[w for w in pg.extract_words(use_text_flow=False,keep_blank_chars=False) if y_lo<=w['top']<=y_hi]
    hdrs=[w for w in ws if w['text'] in sizes_order]; hx=sorted(hdrs,key=lambda w:w['x0'])
    bands=[]; cur=[hx[0]]
    for w in hx[1:]:
        if w['x0']-cur[-1]['x0']>60: bands.append(cur); cur=[w]
        else: cur.append(w)
    bands.append(cur); bdefs=[]
    for b in bands:
        b=sorted(b,key=lambda w:w['x0']); left=min(w['x0'] for w in b)
        bdefs.append({'lo':left-100,'hi':left-4,'sizes':[((w['x0']+w['x1'])/2,w['text']) for w in b]})
    def near(bd,xc): return min(bd['sizes'],key=lambda s:abs(s[0]-xc))[1]
    rows=defaultdict(list)
    for w in ws: rows[round(w['top']/3)*3].append(w)
    out=[]
    for k in sorted(rows):
        rw=rows[k]
        for bd in bdefs:
            mt=[w for w in rw if bd['lo']<=w['x0']<=bd['hi'] and w['text']!='■']
            if not mt: continue
            nm=' '.join(w['text'] for w in sorted(mt,key=lambda w:w['x0'])).strip()
            bl=[w for w in rw if w['text']=='■' and w['x0']>=bd['hi']-2 and w['x0']<=max(s[0] for s in bd['sizes'])+18]
            out.append((nm,set(near(bd,(w['x0']+w['x1'])/2) for w in bl)))
    return out

# A. LA PAZ
byd=defaultdict(dict)
for code,price,_ in re.findall(r'\b([A-Z]{1,4}\d{2,4})\s+\$(\d+\.\d\d)(\s*\*\*\*)?',txt(0)):
    size='4x4' if code[-1]=='4' else ('6x6' if code[-1]=='6' else None)
    if size: byd[code[:-1]][size]={'cost':float(price),'code':code}
for d,sizes in byd.items():
    add(section='La Paz',category='talavera-tile',covering=True,accessory=False,design=d,collection='La Paz',
        woo_cat='Handcrafted Relief Mexican La Paz Tiles',woo_codes=[d+'4',d],base_name=f'La Paz {d}',
        skus=[{'size':s,'cost':i['cost'],'vendor_sku':i['code'],'sqft':sqft(s),'variant':s} for s,i in sorted(sizes.items())],
        attrs={'material':'Ceramic','finish':'Relief','country':'Mexico','collection':'La Paz'})
# B. SANTA BARBARA
for m in re.finditer(r'^([A-Z0-9]{3,5})\s+(\S+)\s+\$(\d+\.\d\d)\s+\$(\d+\.\d\d)',txt(1),re.M):
    code,fintok,p4,p6=m.groups(); fin='Gloss' if 'loss' in fintok else 'Matte'
    add(section='Santa Barbara',category='talavera-tile',covering=True,accessory=False,design=code,collection='Santa Barbara',
        woo_cat='Solid Handcrafted Santa Barbara Tiles',woo_codes=[code],base_name=f'Santa Barbara {code} {fin}',
        skus=[{'size':'4x4','cost':float(p4),'vendor_sku':code,'sqft':sqft('4x4'),'variant':'4x4'},
              {'size':'6x6','cost':float(p6),'vendor_sku':code,'sqft':sqft('6x6'),'variant':'6x6'}],
        attrs={'material':'Ceramic','finish':fin,'country':'Mexico','collection':'Santa Barbara'})
# C. SANTA BARBARA TRIM
for m in re.finditer(r'^([A-Za-z][A-Za-z .]*?)\s+(\d[\d.]*"x ?\d[\d.]*")\s+\$(\d+\.\d\d)',txt(1).split('Santa Barbara Trim')[-1],re.M):
    nm,size,price=m.group(1).strip(),m.group(2),m.group(3)
    add(section='Santa Barbara Trim',category='trim-accessories',covering=False,accessory=True,design=slug('sb '+nm),collection='Santa Barbara',
        woo_cat=None,woo_codes=[],name=f'Santa Barbara {nm}',base_name=f'Santa Barbara {nm}',
        skus=[{'size':size.replace('"','').replace(' ',''),'cost':float(price),'vendor_sku':slug('SB '+nm),'sqft':None,'variant':size}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Santa Barbara','type':'Trim'})
# D. HAND BRUSH
for m in re.finditer(r'HB # (\d+)\s+(?:4"x 4"\s+\$(\d+\.\d\d)\s+)?6"x 6"\s+\$(\d+\.\d\d)(\s+Relief)?',txt(2)):
    n=int(m.group(1)); p4,p6,relief=m.group(2),m.group(3),bool(m.group(4)); skus=[]
    if p4: skus.append({'size':'4x4','cost':float(p4),'vendor_sku':f'HB{n}','sqft':sqft('4x4'),'variant':'4x4'})
    skus.append({'size':'6x6','cost':float(p6),'vendor_sku':f'HB{n}','sqft':sqft('6x6'),'variant':'6x6'})
    add(section='Hand Brush',category='talavera-tile',covering=True,accessory=False,design=f'HB{n}',collection='Hand Brush Matte',
        woo_cat='Hand Brush Matte Tiles',woo_codes=[f'hb-{n}',f'HB{n}'],base_name=f'Hand Brushed #{n}',skus=skus,
        attrs={'material':'Ceramic','finish':'Matte Antique'+(' Relief' if relief else ''),'country':'Mexico','collection':'Hand Brush Matte'})
for nm,size,price in [('Quarter Round','1x6','4.00'),('Bull Nose','2x6','4.50')]:
    add(section='Hand Brush Trim',category='trim-accessories',covering=False,accessory=True,design=slug('hb '+nm),collection='Hand Brush Matte',
        woo_cat=None,woo_codes=[],name=f'Hand Brush {nm} {size}',base_name=f'Hand Brush {nm}',
        skus=[{'size':size,'cost':float(price),'vendor_sku':slug('HB '+nm),'sqft':None,'variant':size}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Hand Brush Matte','type':'Trim'})
# E. DECORATIVE (page4, single-token, whole page)
DECO={'2x2':1.95,'3x3':2.25,'4x4':2.80,'6x6':4.35}
for code,sizes in grid_single(3,('2x2','3x3','4x4','6x6'),re.compile(r'^L-\d')):
    if not sizes: continue
    lc=code.replace('-','')
    add(section='Talavera Decorative',category='talavera-tile',covering=True,accessory=False,design=lc,collection='Talavera Decorative',
        woo_cat='Talavera Decorative Tiles',woo_codes=[lc,code],base_name=f'Talavera {code}',
        skus=[{'size':s,'cost':DECO[s],'vendor_sku':lc,'sqft':sqft(s),'variant':s} for s in sorted(sizes,key=sz_w)],
        attrs={'material':'Ceramic','finish':'Glazed','country':'Mexico','collection':'Talavera Decorative'})
# F. NEW DESIGNS
for m in re.finditer(r'^L-(\d+)\s+■\s+■',txt(4),re.M):
    n=m.group(1); code=f'L-{n}'; lc=f'L{n}'
    add(section='New Talavera',category='talavera-tile',covering=True,accessory=False,design=lc,collection='Talavera Decorative',
        woo_cat='Talavera Decorative Tiles',woo_codes=[lc,code],base_name=f'Talavera {code}',
        skus=[{'size':'4x4','cost':2.80,'vendor_sku':lc,'sqft':sqft('4x4'),'variant':'4x4'},
              {'size':'6x6','cost':4.35,'vendor_sku':lc,'sqft':sqft('6x6'),'variant':'6x6'}],
        attrs={'material':'Ceramic','finish':'Glazed','country':'Mexico','collection':'Talavera Decorative'})
# G. SOLID COLOR (page6 top; multiword; 3rd band = RED WASH)
SOLID={'2x2':1.50,'4x4':2.00,'6x6':3.25}; RW={'2x2':2.50,'4x4':3.00,'6x6':4.25}; seen=set()
for nm,sizes in grid_multi(5,("2x2","4x4","6x6"),118,330):
    nm=nm.strip()
    if not re.match(r'^[A-Z][A-Z ]*$',nm) or nm in ('MODEL',) or not sizes or nm in seen: continue
    seen.add(nm); pmap=RW if nm.replace(' ','')=='REDWASH' else SOLID
    sk=[{'size':s,'cost':pmap[s],'vendor_sku':slug(nm)+'-'+s,'sqft':sqft(s),'variant':s} for s in sorted(sizes,key=sz_w) if s in pmap]
    if not sk: continue
    add(section='Solid Color',category='talavera-tile',covering=True,accessory=False,design=slug(nm),collection='Talavera Solid Color',
        woo_cat='Solids',woo_codes=[nm,slug(nm)],base_name=f'{nm.title()} Solid Talavera',skus=sk,
        attrs={'material':'Ceramic','color':nm.title(),'country':'Mexico','collection':'Talavera Solid Color'})
# H. TALAVERA TRIM PIECES (reg + redwash)
tt=txt(5).split('Talavera Trim Pieces')[-1].split('Talavera Relief')[0]
for m in re.finditer(r'^([A-Z][A-Z /&]+?)\s+(\d[\d. xX]*\d)\s+\$(\d+\.\d\d)\s+\$(\d+\.\d\d)',tt,re.M):
    nm,size,reg,rw=m.group(1).strip(),m.group(2).strip(),m.group(3),m.group(4)
    add(section='Talavera Trim',category='trim-accessories',covering=False,accessory=True,design=slug(nm+' '+size),collection='Talavera Trim',
        woo_cat='Talavera Trim',woo_codes=[nm],name=f'Talavera {nm.title()} {size}',base_name=f'Talavera {nm.title()} {size}',
        skus=[{'size':size.replace(' ',''),'cost':float(reg),'vendor_sku':slug('TT '+nm+' '+size),'sqft':None,'variant':size+' Standard','color':'Standard'},
              {'size':size.replace(' ',''),'cost':float(rw),'vendor_sku':slug('TT '+nm+' '+size+' RW'),'sqft':None,'variant':size+' Red Wash','color':'Red Wash'}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Talavera Trim','type':'Trim'})
# I. RELIEF LINERS (page6 bottom, single-token, y>550)
RLP={'3x3':4.60,'3x6':6.50,'4x4':4.75,'4x8':7.25}
for code,sizes in grid_single(5,('3x3','3x6','4x4','4x8'),re.compile(r'^LN'),y_lo=550,y_hi=9999):
    if not sizes: continue
    add(section='Relief Liners',category='trim-accessories',covering=False,accessory=True,design=slug(code),collection='Talavera Relief Liners',
        woo_cat='Relief Liners & Corner Pieces',woo_codes=[code],name=f'{code} Relief Liner',base_name=f'{code} Relief Liner',
        skus=[{'size':s,'cost':RLP[s],'vendor_sku':slug(code)+'-'+s,'sqft':sqft(s),'variant':s} for s in sorted(sizes,key=sz_w)],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Talavera Relief Liners','type':'Relief Liner'})
# J. SUBWAY
for c in ['BLANCO MEX','BLACK','COBALT BLUE','DARK GREEN','MUSTARD','NAVY WASH','PURO WHITE','TERRACOTTA','TERRACOTTA WASH','TURQUOISE WASH','YELLOW WASH']:
    add(section='Subway',category='talavera-tile',covering=True,accessory=False,design='sub-'+slug(c),collection='Talavera Subway',
        woo_cat='Talavera Subway Tiles',woo_codes=['sub-'+slug(c),c],base_name=f'{c.title()} Talavera Subway',
        skus=[{'size':'3x6','cost':2.25,'vendor_sku':'SUB-'+slug(c)+'-3x6','sqft':sqft('3x6'),'variant':'3x6'},
              {'size':'4x8','cost':3.75,'vendor_sku':'SUB-'+slug(c)+'-4x8','sqft':sqft('4x8'),'variant':'4x8'}],
        attrs={'material':'Ceramic','color':c.title(),'country':'Mexico','collection':'Talavera Subway'})
add(section='Subway',category='talavera-tile',covering=True,accessory=False,design='sub-red-wash',collection='Talavera Subway',
    woo_cat='Talavera Subway Tiles',woo_codes=['sub-redwash','red wash'],base_name='Red Wash Talavera Subway',
    skus=[{'size':'3x6','cost':3.25,'vendor_sku':'SUB-RW-3x6','sqft':sqft('3x6'),'variant':'3x6'},
          {'size':'4x8','cost':4.75,'vendor_sku':'SUB-RW-4x8','sqft':sqft('4x8'),'variant':'4x8'}],
    attrs={'material':'Ceramic','color':'Red Wash','country':'Mexico','collection':'Talavera Subway'})
# K. RUSTICO
for c in ['Blanco & White','Black Gloss','Black Matte','Brown','Burgundy','Cobalt','Dark Green','Gray','Green Wash','Light Blue','Natural','Turquoise']:
    add(section='Rustico',category='talavera-tile',covering=True,accessory=False,design='rst-'+slug(c),collection='Rustico Thin Clay Brick',
        woo_cat='Rustico Brick',woo_codes=[c,slug(c)],base_name=f'Rustico {c}',
        skus=[{'size':'3x8','cost':2.75,'vendor_sku':'RST-'+slug(c),'sqft':sqft('3x8'),'variant':'3x8'}],
        attrs={'material':'Clay Brick','color':c,'country':'Mexico','collection':'Rustico Thin Clay Brick'})
# L. PURO
for n in range(125,149):
    add(section='Puro',category='talavera-tile',covering=True,accessory=False,design=f'PW{n}',collection='Puro White Talavera',
        woo_cat='Puro',woo_codes=[f'puro{n}',f'PW{n}'],base_name=f'PW{n} Puro Talavera',
        skus=[{'size':'4x4','cost':2.75,'vendor_sku':f'PW{n}','sqft':sqft('4x4'),'variant':'4x4'}],
        attrs={'material':'Ceramic','color':'Puro White','country':'Mexico','collection':'Puro White Talavera'})
# M. NUMBERS & FRAMES
for nm,size,price in [('Bouquet/TC House Number','4x4','7.00'),('Cali House Number','4x4','7.75'),('Palm/Dot/W&B/Cacti House Number','3x6','8.95'),('White/Beige/Talavera House Number','4x6','7.75')]:
    add(section='Numbers',category='trim-accessories',covering=False,accessory=True,design=slug(nm),collection='Talavera Numbers',
        woo_cat='Talavera Numerals',woo_codes=[],name=f'Talavera {nm}',base_name=f'Talavera {nm}',
        skus=[{'size':size,'cost':float(price),'vendor_sku':slug('NUM '+nm),'sqft':None,'variant':size}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Talavera Numbers','type':'House Number'})
for cnt,price in [('2','28.10'),('3','30.90'),('4','38.25'),('5','46.50')]:
    add(section='Numbers',category='trim-accessories',covering=False,accessory=True,design=f'number-frame-{cnt}',collection='Talavera Numbers',
        woo_cat=None,woo_codes=[],name=f'Talavera Number Frame ({cnt} digits)',base_name=f'Talavera Number Frame ({cnt} digits)',
        skus=[{'size':'frame','cost':float(price),'vendor_sku':f'NUMFRAME{cnt}','sqft':None,'variant':f'{cnt} digits'}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Talavera Numbers','type':'Number Frame'})
# N. MURALS
for nm,size,price in [('Talavera Mural (35 Pieces)','4x4','260.00'),('Relief Mural #1 & #3','54x24','850.00'),('Relief Mural #2 & #4','52x30','575.00'),('Relief Mural #7','36x24','360.00'),('Relief Mural #5','24x18','250.00')]:
    add(section='Murals',category='medallions',covering=False,accessory=True,design=slug(nm),collection='Talavera Murals',
        woo_cat='Talavera Murals',woo_codes=[],name=nm,base_name=nm,
        skus=[{'size':size,'cost':float(price),'vendor_sku':slug('MURAL '+nm),'sqft':None,'variant':size}],
        attrs={'material':'Ceramic','country':'Mexico','collection':'Talavera Murals','type':'Mural'})
# P. MEXICAN PAVERS (page9 index8): Saltillo (left) + Lincoln (right)
def parse_pavers():
    sal=[]; linc=[]
    for line in txt(8).split('\n'):
        if '$' not in line or 'orders' in line.lower() or 'FLAT RATE' in line or 'SAMPLES' in line and 'Riviera' not in line: 
            if 'Riviera' not in line and 'San Felipe' not in line and not re.match(r'\s*\d',line): continue
        ms=list(re.finditer(r'([0-9][0-9"x .A-Za-z/]*?)\s*\$(\d+\.\d\d)\s+(\d+(?:\.\d+)?)(?=\s|$)',line))
        if ms:
            sal.append(ms[0])
            if len(ms)>1: linc.append(ms[1])
    def mk(matches,label,woo_codes):
        skus=[]
        for m in matches:
            desc=re.sub(r'\s+',' ',m.group(1)).replace('"','').strip(); cost=float(m.group(2)); wt=float(m.group(3))
            desc=re.sub(r'(\d)x (\d)',r'\1x\2',desc)  # '3x 3'->'3x3'
            dm=re.match(r'(\d+)x(\d+)',desc); sf=round(int(dm.group(1))*int(dm.group(2))/144.0,4) if dm else None
            skus.append({'size':desc,'cost':cost,'vendor_sku':slug(label+' '+desc),'sqft':sf,'variant':desc,'weight':wt})
        add(section='Pavers',category='pavers',covering=True,accessory=False,design=slug(label),collection='Mexican Pavers',
            woo_cat='Mexican Pavers',woo_codes=woo_codes,base_name=f'{label} Mexican Paver',name=f'{label} Mexican Paver',skus=skus,
            attrs={'material':'Saltillo Clay','country':'Mexico','collection':'Mexican Pavers','type':'Paver'})
    mk(sal,'Saltillo',['REGULARSALTILLO','SUPERSALTILLO','regular-saltillo'])
    mk(linc,'Lincoln',['LINCOLNPAVER','lincoln-paver'])
parse_pavers()
# Q. AQUA MIX (page10 index9)
def parse_aquamix():
    body=txt(9)
    def prod(nm,skus,typ):
        add(section='Aqua Mix',category='trim-accessories',covering=False,accessory=True,design=slug('aquamix '+nm),collection='Aqua Mix',
            woo_cat='Aqua Mix',woo_codes=[nm],name=f'Aqua Mix {nm}',base_name=f'Aqua Mix {nm}',skus=skus,
            attrs={'brand':'Aqua Mix','collection':'Aqua Mix','type':typ})
    seen=set()
    def norm(nm): return re.sub(r'\x00','ti',nm).strip()
    # two-column: find every (name $quart $gallon) pair on any line (left+right products)
    for m in re.finditer(r'([A-Za-z][A-Za-z\'&/ .\x00-]+?)\s+\$(\d+\.\d\d)\s+\$(\d+\.\d\d)',body):
        nm=norm(m.group(1))
        if nm in seen or len(nm)<4 or nm.split()[-1] in ('Quart','Gallon'): continue
        seen.add(nm)
        prod(nm,[{'size':'Quart','cost':float(m.group(2)),'vendor_sku':slug(nm+' qt'),'sqft':None,'variant':'Quart'},
                 {'size':'Gallon','cost':float(m.group(3)),'vendor_sku':slug(nm+' gal'),'sqft':None,'variant':'Gallon'}],'Sealer/Cleaner')
    # problem solvers: quart price has NO $ ("Nanoscrub 16.88 $42.24")
    for m in re.finditer(r'^([A-Za-z][A-Za-z\'&/ .\x00-]+?)\s+(\d+\.\d\d)\s+\$(\d+\.\d\d)',body,re.M):
        nm=norm(m.group(1))
        if nm in seen or len(nm)<4: continue
        seen.add(nm)
        prod(nm,[{'size':'Quart','cost':float(m.group(2)),'vendor_sku':slug(nm+' qt'),'sqft':None,'variant':'Quart'},
                 {'size':'Gallon','cost':float(m.group(3)),'vendor_sku':slug(nm+' gal'),'sqft':None,'variant':'Gallon'}],'Problem Solver')
    # gallon-only (Grout Sealer $60.93 — single $ not followed by another $)
    for m in re.finditer(r'^(Grout Sealer)\s+\$(\d+\.\d\d)\s*$',body,re.M):
        nm=norm(m.group(1))
        if nm not in seen:
            seen.add(nm); prod(nm,[{'size':'Gallon','cost':float(m.group(2)),'vendor_sku':slug(nm+' gal'),'sqft':None,'variant':'Gallon'}],'Sealer')
    # stains: name + size(Pint/8 oz.) + price
    for m in re.finditer(r'([A-Za-z][A-Za-z\'&/ .\x00-]+?)\s+(8 oz\.|Pint)\s+\$(\d+\.\d\d)',body):
        nm=norm(m.group(1)); size=m.group(2)
        if nm in seen or len(nm)<4: continue
        seen.add(nm)
        prod(nm,[{'size':size,'cost':float(m.group(3)),'vendor_sku':slug(nm+' '+size),'sqft':None,'variant':size}],'Stain')
parse_aquamix()

json.dump(products, open(OUT+'/catalog_pdf.json','w'), indent=1)
c=Counter(p['section'] for p in products)
print('=== SECTION COUNTS ===')
for k in c: print(f'  {k:20s} {c[k]:4d} prod  {sum(len(p["skus"]) for p in products if p["section"]==k):4d} sku')
print('TOTAL:',len(products),'products',sum(len(p['skus']) for p in products),'skus')
