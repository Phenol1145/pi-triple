#!/usr/bin/env python3
"""Check verification/invite requirement text on /register."""
import urllib.request, urllib.parse, re, http.cookiejar

BASE = "https://z-lib.li"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    return opener.open(req, timeout=25)

body = get(BASE + "/register").read().decode(errors="replace")
# find text around 'verification' and 'email'
for kw in ["verification", "Verification", "email", "Email", "invite", "captcha", "reCAPTCHA", "google"]:
    for m in re.finditer(re.escape(kw), body):
        s = max(0, m.start() - 150)
        snippet = re.sub(r"<[^>]+>", " ", body[s:m.end() + 150])
        snippet = re.sub(r"\s+", " ", snippet).strip()
        print(f"[{kw}]: ...{snippet[:250]}...")
        break  # first occurrence each

# check for captcha script
print("\ncaptcha scripts:", re.findall(r'src="([^"]*(?:captcha|recaptcha|hcaptcha)[^"]*)"', body))
print("grecaptcha:", "grecaptcha" in body, "| hcaptcha:", "hcaptcha" in body)
