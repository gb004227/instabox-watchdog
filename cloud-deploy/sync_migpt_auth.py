#!/usr/bin/env python3
# 把 xiaomusic 扫码得到的登录态同步给 MiGPT（.mi.json + .env）
# 只替换 token 相关字段，不动 device/miot 其它缓存
import json, os, shutil, time

ROOT = "/data/xmcloud"
AUTH = os.path.join(ROOT, "data/conf/auth.json")
MIJSON = os.path.join(ROOT, "data/migpt/.mi.json")
ENV = os.path.join(ROOT, ".env")

auth = json.load(open(AUTH, encoding="utf-8"))
new = {
    "deviceId": auth["deviceId"],
    "userId": auth["userId"],
    "passToken": auth["passToken"],
    "serviceToken": auth.get("serviceToken", ""),
}
print("[新 token] " + ", ".join("%s len=%d" % (k, len(str(v))) for k, v in new.items()))

# ---- 1. 备份并更新 .mi.json ----
if os.path.exists(MIJSON):
    bak = MIJSON + ".bak." + time.strftime("%H%M%S")
    shutil.copy2(MIJSON, bak)
    print("[备份] %s" % bak)

mi = json.load(open(MIJSON, encoding="utf-8"))
for sect in ("mina", "miot"):
    seg = mi.get(sect)
    if not isinstance(seg, dict):
        continue
    for k in ("deviceId", "userId", "passToken", "serviceToken"):
        if k in seg and new[k]:
            old_len = len(str(seg.get(k, "")))
            seg[k] = new[k]
            print("  %s.%s  %d -> %d" % (sect, k, old_len, len(str(new[k]))))
json.dump(mi, open(MIJSON, "w", encoding="utf-8"), ensure_ascii=False)
print("[写入] %s" % MIJSON)

# ---- 2. 更新 .env 的 MI_PASS_TOKEN ----
lines = open(ENV, encoding="utf-8").read().splitlines()
out, hit = [], False
for ln in lines:
    if ln.startswith("MI_PASS_TOKEN="):
        out.append("MI_PASS_TOKEN=" + new["passToken"])
        hit = True
    else:
        out.append(ln)
if not hit:
    out.append("MI_PASS_TOKEN=" + new["passToken"])
open(ENV, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("[写入] .env MI_PASS_TOKEN (被更新=%s)" % hit)

# ---- 3. 校验 ----
chk = json.load(open(MIJSON, encoding="utf-8"))
print("[校验] mina.passToken == auth.passToken ->",
      chk["mina"]["passToken"] == auth["passToken"])
print("[校验] miot.passToken == auth.passToken ->",
      chk["miot"]["passToken"] == auth["passToken"])
