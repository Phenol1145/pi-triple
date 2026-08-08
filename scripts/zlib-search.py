#!/usr/bin/env python3
"""Search Z-Library (z-lib.id) — extract book cards via resItemBox."""
import urllib.request, urllib.parse, re, sys

BASE = "https://z-lib.id"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

def clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip()

def extract_cards(body):
    """Parse resItemBox blocks; each has data-book_id + metadata."""
    cards = []
    for m in re.finditer(r'<div class="resItemBox[^"]*"[^>]*data-book_id="([^"]+)"(.*?)(?=<div class="resItemBox|$)', body, re.S):
        bid, inner = m.group(1), m.group(2)
        # title from itemprop="name"
        tm = re.search(r'itemprop="name"[^>]*>\s*<a[^>]*>([^<]+)</a>', inner, re.S)
        title = clean(tm.group(1)) if tm else bid
        author = ""
        am = re.search(r'itemprop="author"[^>]*>([^<]+)</a>', inner)
        if am:
            author = am.group(1).strip()
        year = (re.search(r'property_label">Year:</div>\s*<div class="property_value[^"]*">([^<]+)<', inner) or [None, ""])[1]
        lang = (re.search(r'property_label">Language:</div>\s*<div class="property_value[^"]*">([^<]+)<', inner) or [None, ""])[1]
        fmt = (re.search(r'property_label">File:</div>\s*<div class="property_value[^"]*">([^<]+)<', inner) or [None, ""])[1]
        isbn = (re.search(r'data-isbn="([^"]+)"', inner) or [None, ""])[1]
        cards.append({"id": bid, "title": title, "author": author,
                      "year": year.strip(), "lang": lang.strip(), "fmt": fmt.strip(), "isbn": isbn})
    return cards

query = sys.argv[1] if len(sys.argv) > 1 else "The Selfish Gene"
body = get(f"{BASE}/s/?q={urllib.parse.quote(query)}")
tm = re.search(r"<title>(.*?)</title>", body, re.S)
print("page title:", tm.group(1).strip() if tm else "?")

cards = extract_cards(body)
print(f"\n== 搜索结果: {query} — {len(cards)} 条 ==")
for i, c in enumerate(cards, 1):
    print(f"  {i}. [{c['fmt']}] {c['title']} — {c['author']} ({c['year']}, {c['lang']}) id={c['id']}")
