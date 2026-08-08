#!/usr/bin/env python3
"""Check what z-lib.id serves (books vs articles) and try language variants."""
import urllib.request, urllib.parse, re

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

body = get("https://z-lib.id/")
print("== z-lib.id 首页特征 ==")
for kw in ["/book/", "/books", "ebook", "resItemBoxBooks", "data-mode", "data-sitemode", "article"]:
    print(f"  '{kw}': {body.count(kw)} 次")
md = re.search(r'<meta name="description" content="([^"]*)"', body)
if md:
    print("  desc:", md.group(1)[:150])

# 试 zh 语言子路径搜索
print("\n== 语言变体搜索 三体 ==")
for prefix in ["", "zh/"]:
    url = f"https://z-lib.id/{prefix}s/?q=" + urllib.parse.quote("三体")
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        print(f"  {prefix or '(default)'}: cards={b.count('resItemBoxBooks')} title={tm.group(1).strip()[:50] if tm else '?'}")
    except Exception as e:
        print(f"  {prefix or '(default)'}: ERR {str(e)[:60]}")
