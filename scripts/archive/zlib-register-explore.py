#!/usr/bin/env python3
"""Explore z-lib.li /register page in detail."""
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

r = get(BASE + "/register")
body = r.read().decode(errors="replace")
print("status:", r.status)
tm = re.search(r"<title>(.*?)</title>", body, re.S)
print("title:", tm.group(1).strip()[:80] if tm else "?")
print("len:", len(body))

forms = re.findall(r'<form[^>]*>(.*?)</form>', body, re.S)
print("\nforms:", len(forms))
for i, f in enumerate(forms):
    inputs = re.findall(r'<input[^>]*>', f)
    selects = re.findall(r'<select[^>]*>', f)
    print(f"  form{i}: inputs={len(inputs)} selects={len(selects)}")
    for inp in inputs:
        name = re.search(r'name="([^"]*)"', inp)
        typ = re.search(r'type="([^"]*)"', inp)
        print(f"    {typ.group(1) if typ else '?':12s} {name.group(1) if name else '?'}")
    for sel in selects:
        action = re.search(r'name="([^"]*)"', sel)
        opts = re.findall(r'<option[^>]*value="([^"]*)"', f)
        print(f"    select {action.group(1) if action else '?'}: options={opts[:10]}")

# any hint about email verification / invite
for kw in ["invite", "verification", "verify", "email", "invitation", "beta"]:
    if kw.lower() in body.lower():
        print(f"\n[hint] contains: {kw}")
