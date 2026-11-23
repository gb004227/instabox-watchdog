#!/usr/bin/env python3
"""探测小米账号凭据是否还有效：只读本地缓存文件，不打印任何 token 值。"""
import json
import urllib.request

mi = json.load(open("xiaoai-migpt/.mi.json", encoding="utf-8"))["mina"]
au = json.load(open("data/conf/auth.json", encoding="utf-8"))

print("deviceId(mi.json) len =", len(mi["deviceId"]))
print("deviceId(auth)    len =", len(au["deviceId"]))
print("serviceToken(mi)  len =", len(mi.get("serviceToken", "")))
print("userId            =", mi.get("userId"))
print("passToken 相同     =", mi["passToken"] == au["passToken"])

URL = "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true"
UA = "Mozilla/5.0 (Linux; Android 10; MI 11) AppleWebKit/537.36"

for tag, tok in (("mi.json", mi), ("auth.json", au)):
    cookies = "deviceId={0}; userId={1}; passToken={2}".format(
        tok["deviceId"], tok["userId"], tok["passToken"]
    )
    req = urllib.request.Request(URL, headers={"Cookie": cookies, "User-Agent": UA})
    try:
        body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
        body = body.replace("&&&START&&&", "")
        d = json.loads(body)
        print(
            "[{0}] code={1} desc={2} secStatus={3} hasUserId={4} hasLocation={5} notify={6}".format(
                tag,
                d.get("code"),
                d.get("description") or d.get("desc"),
                d.get("securityStatus"),
                "userId" in d,
                bool(d.get("location")),
                "notificationUrl" in d,
            )
        )
    except Exception as e:
        print("[{0}] ERROR {1}: {2}".format(tag, type(e).__name__, e))
