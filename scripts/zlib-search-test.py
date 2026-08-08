#!/usr/bin/env python3
"""Z-Library search test via proxy — solves PoW challenge then searches."""
import re, hashlib, http.cookiejar, urllib.request, urllib.parse, json, sys

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://singlelogin.re"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

def get(url, referer=None):
    h = {"User-Agent": UA}
    if referer:
        h["Referer"] = referer
    return opener.open(urllib.request.Request(url, headers=h), timeout=25)

def get_title(html):
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    return m.group(1).strip()[:80] if m else "?"

print(f"== {BASE} ==")
# 1. fetch challenge page
html = get(BASE + "/").read().decode()
m = re.search(r'var TOKEN="([^"]+)"', html)
d = re.search(r"var DIFF=(\d+)", html)
if not m:
    print("no challenge; direct access. title:", get_title(html))
    sys.exit(1)

token, diff = m.group(1), int(d.group(1))
nonce = 0
while not hashlib.sha256(f"{token}:{nonce}".encode()).hexdigest().startswith("0" * diff):
    nonce += 1
print(f"PoW solved: diff={diff} nonce={nonce}")

get(f"{BASE}/__ab/verify?t={urllib.parse.quote(token)}&n={nonce}&r=%2F")
html2 = get(BASE + "/").read().decode()
print("root title:", get_title(html2))

# 2. search
data = urllib.parse.urlencode({
    "message": "The Selfish Gene", "yearFrom": "0", "yearTo": "2026",
    "languages": "english", "extensions": "pdf,epub,mobi",
    "limit": "5", "order": "popular"}).encode()
req = urllib.request.Request(BASE + "/eapi/book/search", data=data, headers={
    "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA,
    "Referer": BASE + "/", "X-Requested-With": "XMLHttpRequest"})
r = opener.open(req, timeout=30)
b = r.read().decode()
print("search status:", r.status, "len:", len(b))
try:
    j = json.loads(b)
    print("success:", j.get("success"), "total:", j.get("total"))
    for book in j.get("books", [])[:5]:
        print(f"  [{book.get('extension')}] {book.get('title')} — {book.get('author')} ({book.get('year')}, {book.get('language')}) id={book.get('id')}")
except Exception:
    print("non-JSON response:", b[:300])
