#!/usr/bin/env python3
"""Search Z-Library publisher page + Chinese title variants."""
import urllib.request, urllib.parse, re

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

def count_cards(body):
    return body.count("resItemBoxBooks")

print("== 1. 出版社页: 人民邮电 ==")
for p in ["人民邮电", "人民邮电出版社", "People%27s%20Posts"]:
    url = f"https://z-lib.li/publisher/{p}"
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        title = tm.group(1).strip()[:70] if tm else "?"
        print(f"  {p}: cards={count_cards(b)} title={title}")
    except Exception as e:
        print(f"  {p}: ERR {str(e)[:70]}")

print("\n== 2. 中文搜索: 算法 ==")
for q in ["算法", "算法 第四版", "Algorithms 4th", "算法 图灵"]:
    url = "https://z-lib.li/s/?q=" + urllib.parse.quote(q)
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        title = tm.group(1).strip()[:70] if tm else "?"
        print(f"  {q}: cards={count_cards(b)} title={title}")
    except Exception as e:
        print(f"  {q}: ERR {str(e)[:70]}")
