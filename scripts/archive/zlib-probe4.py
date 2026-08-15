#!/usr/bin/env python3
"""Try different Three-Body queries on z-lib.li."""
import urllib.request, urllib.parse, re

UA = {"User-Agent": "Mozilla/5.0"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25).read().decode(errors="replace")

for q in ["The Three-Body Problem", "Three Body", "刘慈欣", "santi"]:
    url = "https://z-lib.li/s/?q=" + urllib.parse.quote(q)
    try:
        b = get(url)
        tm = re.search(r"<title>(.*?)</title>", b, re.S)
        cards = b.count("resItemBoxBooks")
        title = tm.group(1).strip()[:60] if tm else "?"
        print(f"{q}: cards={cards} title={title}")
    except Exception as e:
        print(f"{q}: ERR {str(e)[:70]}")
