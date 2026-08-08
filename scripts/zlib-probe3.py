#!/usr/bin/env python3
"""Test search on z-lib.li (official domain from Config)."""
import urllib.request, urllib.parse, re

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

for q in ["The Selfish Gene", "三体", "Python"]:
    url = "https://z-lib.li/s/?q=" + urllib.parse.quote(q)
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        cards = b.count("resItemBoxBooks")
        title = tm.group(1).strip()[:60] if tm else "?"
        print(f"{q}: cards={cards} title={title}")
    except Exception as e:
        print(f"{q}: ERR {str(e)[:70]}")
