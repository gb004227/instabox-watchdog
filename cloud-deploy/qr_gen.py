#!/usr/bin/env python3
"""生成小米账号扫码登录二维码：调 xiaomusic 的 /api/get_qrcode，
把扫码内容渲染成本地 PNG（小米只返回扫码 URL，不返回图片）。"""
import io
import json
import sys
import urllib.request

from qrcode import QRCode

OUT = "/app/conf/qr.png"

resp = json.load(urllib.request.urlopen("http://127.0.0.1:8090/api/get_qrcode", timeout=25))
if not resp.get("success"):
    print("FAIL", resp.get("message"))
    sys.exit(1)
if resp.get("already_logged_in"):
    print("ALREADY_LOGGED_IN")
    sys.exit(0)

url = resp.get("qrcode_url") or ""
print("qrcode_url =", url)
print("expire_seconds =", resp.get("expire_seconds"))

qr = QRCode(version=2, box_size=8, border=3)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white")
buf = io.BytesIO()
img.save(buf, "PNG")
data = buf.getvalue()
with open(OUT, "wb") as f:
    f.write(data)
print("PNG bytes =", len(data), "->", OUT)
