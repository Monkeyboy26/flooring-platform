#!/usr/bin/env python3
"""
Crawl stone-pride.com (WordPress) and harvest all product image URLs so they can
be matched to Stone Pride SKUs/products by the item code embedded in the filename.

BFS depth<=2 from the nav category pages, same-domain, collecting every
/wp-content/uploads/*.jpg|png (full-size, thumbnails dropped). Emits:
  scratch/sp_images.json  -> [{url, filename, page}]
Run: python3 backend/scripts/crawl-stone-pride-images.py
"""
import subprocess, re, json, sys, os, time
from urllib.parse import urljoin, urlparse

OUT = os.environ.get("SP_IMG_OUT", "/private/tmp/claude-501/-Users-kianassarpour-Desktop-flooring-platform/99f40623-9d8d-48e9-a4bb-572cf664f98b/scratchpad/sp_images.json")
DOMAIN = "stone-pride.com"

SEEDS = [
    "https://www.stone-pride.com/",
    "https://www.stone-pride.com/marble-mosaics/",
    "https://www.stone-pride.com/natural-stone-tile/",
    "https://www.stone-pride.com/waterjet-mosaics/",
    "https://www.stone-pride.com/borders/",
    "https://www.stone-pride.com/frames/",
    "https://www.stone-pride.com/glass-mosaics/",
    "https://www.stone-pride.com/pavers/",
    "https://www.stone-pride.com/terrazzo/",
    "https://www.stone-pride.com/terrazzo-tiles/",
    "https://www.stone-pride.com/medallions/",
    "https://www.stone-pride.com/medallions/round-medallions/",
    "https://www.stone-pride.com/medallions/square-medallions/",
    "https://www.stone-pride.com/medallions/oval-medallions/",
    "https://www.stone-pride.com/medallions/rectangular-medallion/",
]

def fetch(url):
    try:
        return subprocess.check_output(
            ["curl", "-sL", "-m", "25", "-A", "Mozilla/5.0", url],
            stderr=subprocess.DEVNULL).decode("utf-8", "replace")
    except Exception as e:
        print("  ! fetch failed", url, e, file=sys.stderr)
        return ""

IMG_RE = re.compile(r'https?://[^\s"\'\)<>]*?/wp-content/uploads/[^\s"\'\)<>]+?\.(?:jpg|jpeg|png)', re.I)
HREF_RE = re.compile(r'href=["\'](https?://[^"\']+|/[^"\']+)["\']', re.I)
THUMB_RE = re.compile(r'-\d{2,4}x\d{2,4}(?=\.(?:jpg|jpeg|png)$)', re.I)
SKIP_IMG = re.compile(r'(header|logo|banner|icon|slider|favicon|placeholder|about|contact|footer)', re.I)

def norm_full(u):
    # drop wordpress -WxH thumbnail suffix to get the full-size original
    return re.sub(r'-\d{2,4}x\d{2,4}(\.(?:jpg|jpeg|png))$', r'\1', u, flags=re.I)

def is_page(u):
    p = urlparse(u)
    if DOMAIN not in p.netloc: return False
    if re.search(r'\.(jpg|jpeg|png|gif|pdf|zip|css|js|xml|ico)$', p.path, re.I): return False
    if re.search(r'/wp-(admin|content|includes|json)|/feed|/cart|/checkout|/comment|\?', u, re.I): return False
    return True

def main():
    seen_pages, queue = set(), [(s, 0) for s in SEEDS]
    images = {}   # full_url -> {url, filename, pages:set}
    while queue:
        url, depth = queue.pop(0)
        url = url.split('#')[0].rstrip('/') or url
        if url in seen_pages: continue
        seen_pages.add(url)
        html = fetch(url)
        if not html: continue
        # images on this page
        for m in IMG_RE.findall(html):
            full = norm_full(m)
            fn = full.rsplit('/', 1)[-1]
            if SKIP_IMG.search(fn): continue
            rec = images.setdefault(full, {"url": full, "filename": fn, "pages": set()})
            rec["pages"].add(url)
        # follow links one/two levels deep
        if depth < 2:
            for href in HREF_RE.findall(html):
                nxt = urljoin(url, href).split('#')[0].rstrip('/')
                if is_page(nxt) and nxt not in seen_pages:
                    queue.append((nxt, depth + 1))
        time.sleep(0.15)
    out = [{"url": r["url"], "filename": r["filename"], "pages": sorted(r["pages"])} for r in images.values()]
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"Pages crawled: {len(seen_pages)}")
    print(f"Product images: {len(out)}")
    # quick code-prefix distribution
    from collections import Counter
    pref = Counter()
    for r in out:
        m = re.match(r'(MS|Tile|MM|ML|MSL|FR|SU|Terrazzo)', r["filename"], re.I)
        pref[m.group(1) if m else "other"] += 1
    print("Filename code-prefix dist:", dict(pref))

if __name__ == "__main__":
    main()
