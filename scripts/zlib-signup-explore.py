#!/usr/bin/env python3
"""Explore z-lib.li signup page structure to see if automated signup is feasible."""
import urllib.request, urllib.parse, re, http.cookiejar

BASE = "https://z-lib.li"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url, data=None, referer=None):
    h = dict(UA)
    if referer:
        h["Referer"] = referer
    if data is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=h)
    return opener.open(req, timeout=25)

# find signup links on homepage / login page
for path in ["/login", "/registration", "/signup", "/register"]:
    try:
        r = get(BASE + path)
        body = r.read().decode(errors="replace")
        tm = re.search(r"<title>(.*?)</title>", body, re.S)
        forms = re.findall(r'<form[^>]*>', body)
        print(f"== {path}: status={r.status} title={tm.group(1).strip()[:50] if tm else '?'} forms={len(forms)}")
        for f in forms[:3]:
            print("   ", f)
        inputs = re.findall(r'<input[^>]*>', body)
        for i in inputs[:10]:
            print("   in:", i[:120])
        # any signup link?
        for m in re.finditer(r'href="([^"]*(?:signup|registration|register)[^"]*)"', body):
            print("   signup link:", m.group(1))
        break  # only first reachable
    except Exception as e:
        print(f"== {path}: ERR {str(e)[:80]}")
