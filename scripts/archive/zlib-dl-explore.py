#!/usr/bin/env python3
"""Explore book detail page download mechanism on z-lib.li."""
import urllib.request, urllib.parse, re

BASE = "https://z-lib.li"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}

def get(url, data=None, referer=None):
    h = dict(UA)
    if referer:
        h["Referer"] = referer
    if data is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded"
        h["X-Requested-With"] = "XMLHttpRequest"
    req = urllib.request.Request(url, data=data, headers=h)
    return urllib.request.urlopen(req, timeout=25)

# book page for 算法导论（原书第3版）
bid = "book3-16535"
try:
    body = get(f"{BASE}/book/{bid}").read().decode(errors="replace")
    print("book page len:", len(body))
    tm = re.search(r"<title>(.*?)</title>", body, re.S)
    print("title:", tm.group(1).strip()[:100] if tm else "?")
    # find download-related elements
    for kw in ["download", "Download", "dl", "file", "get", "/book/"]:
        hits = re.findall(r'(?:href|action)="([^"]*' + kw + r'[^"]*)"', body)
        if hits:
            print(f"  [{kw}] links:", hits[:6])
    # find any JSON/script with download url patterns
    for pat in [r"https?://[^\"' ]*\.pdf[^\"' ]*", r"/dl[^\"' ]*", r"getBook[^\"' ]*", r"downloadBook[^\"' ]*"]:
        hits = re.findall(pat, body)
        if hits:
            print(f"  [pat {pat}] hits:", hits[:5])
    # login requirement hints
    for kw in ["login", "sign in", "Log in", "guest", "limit"]:
        if kw.lower() in body.lower():
            print(f"  [hint] contains: {kw}")
except Exception as e:
    print("ERR:", str(e)[:120])
