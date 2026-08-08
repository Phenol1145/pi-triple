#!/usr/bin/env python3
"""More variants for 算法 (Sedgewick, 人民邮电)."""
import urllib.request, urllib.parse, re, sys
sys.path.insert(0, "/tmp")
from zlib_search import extract_cards

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

def show(q, url):
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        title = tm.group(1).strip()[:70] if tm else "?"
        cards = extract_cards(b)
        print(f"== {q} — {len(cards)} 条 (title: {title})")
        for c in cards[:8]:
            print(f"  [{c['fmt']}] {c['title'][:70]} — {c['author'][:30]} ({c['year']}, {c['lang']}) id={c['id']}")
    except Exception as e:
        print(f"== {q} ERR: {str(e)[:70]}")
    print()

for q in ["Sedgewick 算法", "Algorithms Sedgewick", "算法导论", "Algorithms 4th edition",
          "Introduction to Algorithms", "算法 人民邮电"]:
    show(q, "https://z-lib.li/s/?q=" + urllib.parse.quote(q))
