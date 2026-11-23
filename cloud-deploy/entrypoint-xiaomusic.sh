#!/bin/sh
# xiaomusic 容器入口：用环境变量渲染 config.json（不用 sed，凭据里含 & | \ 也不会写坏）
set -eu

: "${MI_USER:?环境变量 MI_USER 未设置}"
: "${MI_PASS:?环境变量 MI_PASS 未设置}"
: "${PLAYLIST_URL:?环境变量 PLAYLIST_URL 未设置}"

# 音箱访问音乐服务用的公网地址：优先 MUSIC_PUBLIC_URL，退回 PUBLIC_HOSTNAME
if [ -z "${MUSIC_PUBLIC_URL:-}" ]; then
  MUSIC_PUBLIC_URL="${PUBLIC_HOSTNAME:-}"
fi
export MUSIC_PUBLIC_URL
[ -n "$MUSIC_PUBLIC_URL" ] || {
  echo "[entrypoint] 错误：MUSIC_PUBLIC_URL 或 PUBLIC_HOSTNAME 必须设置一个" >&2
  exit 1
}

python3 - <<'PY'
import json, os

tpl_path = "/app/config.template.json"
out_path = "/app/config.json"

with open(tpl_path, encoding="utf-8") as f:
    cfg = json.load(f)

mapping = {
    "account": "MI_USER",
    "password": "MI_PASS",
    "mi_did": "MI_DID",
    "hostname": "MUSIC_PUBLIC_URL",
    "music_list_url": "PLAYLIST_URL",
}
for key, env in mapping.items():
    val = os.environ.get(env, "") or ""
    if val:
        cfg[key] = val
    elif str(cfg.get(key, "")).startswith("__"):
        cfg[key] = ""          # 未提供就留空；mi_did 为空 = xiaomusic 自动发现第一台设备

# 老变量名兜底：只给 PUBLIC_HOSTNAME 时，hostname 仍用它
if not os.environ.get("MUSIC_PUBLIC_URL"):
    legacy = os.environ.get("PUBLIC_HOSTNAME", "") or ""
    if legacy:
        cfg["hostname"] = legacy

cfg["port"] = int(os.environ.get("XIAOMUSIC_PORT") or cfg.get("port") or 8090)

# public_port 是拼进音乐 URL 的端口。反向代理/NAT 场景下要显式给：
#   标准端口（https 443）→ PUBLIC_PORT=443，拼出 https://host:443/music/x
#   未给 → 与监听端口一致（本机直连的默认行为）
cfg["public_port"] = int(
    os.environ.get("PUBLIC_PORT") or os.environ.get("XIAOMUSIC_PORT") or cfg.get("public_port") or 8090
)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

print("[entrypoint] config.json 已生成: hostname=%s playlist=%s did=%s"
      % (cfg.get("hostname"), cfg.get("music_list_url"), cfg.get("mi_did") or "(自动发现)"))
PY

echo "[entrypoint] 启动 xiaomusic :${XIAOMUSIC_PORT:-8090}"
exec python -m xiaomusic.cli --config /app/config.json
