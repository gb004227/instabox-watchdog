#!/usr/bin/env python3
# 检查扫码后登录态是否真的有效（只打印键名/长度，不泄露值）
import json, os, sys

CONF = "/data/xmcloud/data/conf"

def show(path):
    print("######## %s ########" % path)
    if not os.path.exists(path):
        print("  [不存在]")
        return None
    st = os.stat(path)
    print("  size=%d mtime=%s" % (st.st_size, __import__("time").strftime("%H:%M:%S", __import__("time").localtime(st.st_mtime))))
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        print("  parse fail: %s" % e)
        raw = open(path, encoding="utf-8", errors="replace").read()
        print("  raw head: %r" % raw[:200])
        return None
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, (dict, list)):
                print("  %-16s %s" % (k, type(v).__name__))
            else:
                s = str(v)
                short = s if len(s) <= 6 else "%s...len=%d" % (s[:4], len(s))
                print("  %-16s %s" % (k, short))
    return d

auth = show(os.path.join(CONF, "auth.json"))
show(os.path.join(CONF, ".mi.token"))

if isinstance(auth, dict):
    need = ["userId", "passToken", "deviceId"]
    miss = [k for k in need if not auth.get(k)]
    print("\n[判定] 缺失字段: %s" % (miss or "无"))
    print("[判定] userId=%s" % auth.get("userId"))
