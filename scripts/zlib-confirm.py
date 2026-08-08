#!/usr/bin/env python3
"""Decode mojibake title + confirm 算法导论 人民邮电 (计算机科学丛书)."""
import urllib.request, urllib.parse, re, sys
sys.path.insert(0, "/tmp")
from zlib_search import extract_cards

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

# 1. decode mojibake: utf-8 bytes read as latin-1 -> re-encode latin-1 -> decode utf-8
mojibake = "ç®—æ³•ï¼ˆç¬¬4ç‰ˆï¼‰=Algorithms 4th edition"
decoded = mojibake.encode("latin-1", errors="replace").decode("utf-8", errors="replace")
print("解码标题:", decoded)
auth = "å¡žå¥‡å¨\x81å…‹"
print("解码作者:", auth.encode("latin-1", errors="replace").decode("utf-8", errors="replace"))

# 2. 算法导论 人民邮电版详情
print("\n== 算法导论（原书第3版）/计算机科学丛书 ==")
b = get("https://z-lib.li/s/?q=" + urllib.parse.quote("算法导论"))
cards = extract_cards(b)
for c in cards:
    print(f"  [{c['fmt']}] {c['title'][:60]} — ({c['year']}, {c['lang']}) id={c['id']}")
    if "计算机科学丛书" in c["title"] or "原书第3版" in c["title"]:
        try:
            page = get(f"https://z-lib.li/book/{c['id']}")
            tm = re.search(r"<title>(.*?)</title>", page, re.S)
            print("    detail title:", tm.group(1).strip()[:90] if tm else "?")
            pub = re.findall(r"publisher[^<]{0,80}", page)
            print("    publisher hints:", [p[:70] for p in pub[:3]])
        except Exception as e:
            print("    ERR:", str(e)[:60])
