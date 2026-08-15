#!/usr/bin/env python3
"""Check book detail page for 算法（第4版）— confirm publisher 人民邮电."""
import urllib.request, urllib.parse, re, sys
sys.path.insert(0, "/tmp")
from zlib_search import extract_cards

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

# find the mojibake-titled book id from search
b = get("https://z-lib.li/s/?q=" + urllib.parse.quote("Algorithms 4th edition"))
cards = extract_cards(b)
target = None
for c in cards:
    if "2012" in c["year"] and c["lang"].lower() == "chinese":
        target = c
        print("found candidate:", c)
        break
if target:
    bid = target["id"]
    print("\n== 打开书籍页:", bid, "==")
    try:
        page = get(f"https://z-lib.li/book/{bid}")
        tm = re.search(r"<title>(.*?)</title>", page, re.S)
        print("title tag:", tm.group(1).strip()[:100] if tm else "?")
        # publisher info
        for kw in ["publisher", "出版社", "出版"]:
            for m in re.finditer(kw + r'[^<]{0,60}', page):
                s = m.group(0)[:80]
                print(f"  [{kw}] {s}")
                break
        # look for bookDetails
        det = re.search(r'class="bookDetailsBox"(.{0,1500})', page, re.S)
        if det:
            txt = re.sub(r"<[^>]+>", " ", det.group(1))
            txt = re.sub(r"\s+", " ", txt)
            print("details:", txt[:300])
    except Exception as e:
        print("ERR:", str(e)[:100])
