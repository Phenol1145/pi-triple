#!/usr/bin/env python3
"""Inspect People's Posts publisher page + 算法第四版 search results."""
import urllib.request, urllib.parse, re, sys
sys.path.insert(0, "/tmp")
from zlib_search import extract_cards

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

print("== People's Posts 出版社页 ==")
b = get("https://z-lib.li/publisher/People%27s%20Posts")
tm = re.search(r"<title>(.*?)</title>", b, re.S)
print("title:", tm.group(1).strip()[:80] if tm else "?")
for c in extract_cards(b)[:10]:
    print(f"  [{c['fmt']}] {c['title'][:70]} — {c['author'][:30]} ({c['year']}, {c['lang']}) id={c['id']}")

print("\n== 算法 第四版 ==")
b2 = get("https://z-lib.li/s/?q=" + urllib.parse.quote("算法 第四版"))
tm2 = re.search(r"<title>(.*?)</title>", b2, re.S)
print("title:", tm2.group(1).strip()[:80] if tm2 else "?")
for c in extract_cards(b2)[:10]:
    print(f"  [{c['fmt']}] {c['title'][:70]} — {c['author'][:30]} ({c['year']}, {c['lang']}) id={c['id']}")
