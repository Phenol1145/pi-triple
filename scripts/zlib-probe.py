#!/usr/bin/env python3
"""Probe a Z-Library mirror — check if it's the real site and search works."""
import urllib.request, urllib.parse, re, json, sys

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}

def get(url, referer=None, data=None):
    h = dict(UA)
    if referer:
        h["Referer"] = referer
    if data is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded"
        h["X-Requested-With"] = "XMLHttpRequest"
    req = urllib.request.Request(url, data=data, headers=h)
    return urllib.request.urlopen(req, timeout=25)

for base in ["https://1lib.ch", "https://z-lib.id"]:
    print(f"== {base}")
    try:
        body = get(base + "/").read().decode(errors="replace")
        t = re.search(r"<title>(.*?)</title>", body, re.S)
        print("   title:", t.group(1).strip()[:80] if t else "?")
        for kw in ["Z-Library", "z-lib", "login", "sign in"]:
            if kw.lower() in body.lower():
                print("   contains:", kw)
        # try eapi search directly
        data = urllib.parse.urlencode({
            "message": "The Selfish Gene", "yearFrom": "0", "yearTo": "2026",
            "languages": "english", "extensions": "pdf,epub,mobi",
            "limit": "5", "order": "popular"}).encode()
        r = get(base + "/eapi/book/search", referer=base + "/", data=data)
        b = r.read().decode(errors="replace")
        print("   eapi status:", r.status, "len:", len(b))
        try:
            j = json.loads(b)
            print("   success:", j.get("success"), "total:", j.get("total"))
            for book in j.get("books", [])[:5]:
                print(f"   [{book.get('extension')}] {book.get('title')} — {book.get('author')} ({book.get('year')})")
        except Exception:
            print("   non-JSON:", b[:200].replace("\n", " "))
    except Exception as e:
        print("   ERR:", str(e)[:120])
