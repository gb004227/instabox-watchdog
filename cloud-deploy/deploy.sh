#!/usr/bin/env bash
# 云服务器一键部署：小爱音箱全栈（MiGPT 控制台 + xiaomusic + 网易云直链代理）
# 用法：bash deploy.sh
#
# 设计要点：
#   - 绝不 source .env：网易云 Cookie 里有 ; = 空格，source 会执行出错
#   - 所有校验先做，失败立刻退出并给出可执行的下一步
#   - 歌单单独 bind mount 到 data/playlist.json，重建镜像不丢
set -euo pipefail
cd "$(dirname "$0")"

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$G" "$*" "$Z"; }
ok()   { printf '    %s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '    %s! %s%s\n' "$Y" "$*" "$Z"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

getenv() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
jval()   { python3 -c "import json,sys;d=json.load(open('$1'));print(d.get('$2',''))" 2>/dev/null || true; }

printf '%s\n' "════════════════════════════════════════════" \
              " 小爱音箱全栈 · 云服务器部署" \
              "════════════════════════════════════════════"

# ── 1. 环境自检 ─────────────────────────────────────────────
step "1/6 环境自检"
command -v docker >/dev/null || die "缺少 docker：curl -fsSL https://get.docker.com | bash && systemctl enable --now docker"
docker compose version >/dev/null 2>&1 || die "缺少 docker compose v2 插件"
docker info >/dev/null 2>&1 || die "docker daemon 未运行：systemctl start docker"
[ -f .env ] || die "缺少 .env：cp .env.example .env 后填写（小米账号 / 公网地址 / 大模型 key）"

PUBLIC_HOSTNAME="$(getenv PUBLIC_HOSTNAME)"
MI_USER="$(getenv MI_USER)"
MI_PASS="$(getenv MI_PASS)"
NC="$(getenv NETEASE_COOKIE)"
NUID="$(getenv NETEASE_UID)"
[ -n "$PUBLIC_HOSTNAME" ] || die ".env 的 PUBLIC_HOSTNAME 为空（填 http://公网IP，不带端口和斜杠）"
[ -n "$MI_USER" ] && [ -n "$MI_PASS" ] || die ".env 的 MI_USER / MI_PASS 为空"
[ -n "$NC" ] || warn "NETEASE_COOKIE 为空：歌单会退化为 B 站兜底，周杰伦以外曲目可能缺失"
ok "PUBLIC_HOSTNAME=$PUBLIC_HOSTNAME"
ok "MI_USER=${MI_USER:0:3}***"

# ── 2. 数据目录 ─────────────────────────────────────────────
step "2/6 准备数据目录"
mkdir -p data/music data/conf
[ -f data/playlist.json ] || printf '{}' >data/playlist.json
ok "data/{music,conf,playlist.json} 就绪"

# ── 3. 同步源码 ─────────────────────────────────────────────
step "3/6 同步 xiaoai-migpt 源码"
SRC="../xiaoai-migpt"
if [ -d "$SRC" ]; then
  rm -rf ./xiaoai-migpt
  mkdir -p ./xiaoai-migpt
  cp -a "$SRC"/. ./xiaoai-migpt/
  rm -rf ./xiaoai-migpt/node_modules ./xiaoai-migpt/.mi.json ./xiaoai-migpt/*.log
  ok "已从 $SRC 同步（已剔除 node_modules / .mi.json）"
elif [ -d ./xiaoai-migpt ]; then
  ok "使用 cloud-deploy 内置的 xiaoai-migpt"
else
  die "找不到 xiaoai-migpt 源码（放在 cloud-deploy 同级，或拷进 cloud-deploy/）"
fi
[ -f ./xiaoai-migpt/package-lock.json ] || die "xiaoai-migpt 缺少 package-lock.json（npm ci 需要）"

# ── 4. 构建 ─────────────────────────────────────────────────
step "4/6 构建镜像（首次 3-8 分钟）"
docker compose build
ok "镜像构建完成"

# ── 5. 启动 + 就绪等待 ──────────────────────────────────────
step "5/6 启动容器"
docker compose up -d
for i in $(seq 1 45); do
  curl -fsS -m 3 http://127.0.0.1:3000/ >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 3 http://127.0.0.1:3000/ >/dev/null 2>&1 || die "控制台 3000 未就绪：docker compose logs console"
ok "控制台 :3000 就绪"
curl -fsS -m 3 http://127.0.0.1:8090/ >/dev/null 2>&1 || warn "xiaomusic :8090 还没起来，继续（稍后看日志）"

# ── 6. 生成歌单 + 刷新 ──────────────────────────────────────
step "6/6 生成网易云歌单（约 1-3 分钟）"
if docker compose exec -T \
    -e NETEASE_COOKIE="$NC" \
    -e NETEASE_UID="$NUID" \
    -e STREAM_BASE=http://console:3000/netease-stream \
    console node gen-netease-playlist.mjs; then
  ok "歌单生成完成"
else
  warn "歌单生成失败，可稍后重跑（见文档第六节）"
fi

SIZE=$(docker compose exec -T console sh -c 'wc -c < public/xiaomusic-playlist.json' 2>/dev/null | tr -dc '0-9' || true)
COUNT=$(docker compose exec -T console sh -c 'grep -o "\"name\"" public/xiaomusic-playlist.json | wc -l' 2>/dev/null | tr -dc '0-9' || true)
ok "playlist ${SIZE:-0} 字节 / ${COUNT:-0} 条"

curl -fsS -m 10 -X POST http://127.0.0.1:8090/cmd \
  -H 'Content-Type: application/json' \
  -d '{"did":"","cmd":"刷新列表"}' >/dev/null 2>&1 \
  && ok "已让 xiaomusic 刷新网络歌单" || warn "刷新列表未成功，可在 8090 页面手动点"

# ── 汇总 ────────────────────────────────────────────────────
HOSTPORT="${PUBLIC_HOSTNAME#http://}"; HOSTPORT="${HOSTPORT#https://}"; HOSTPORT="${HOSTPORT%/}"
printf '\n%s\n' "════════════════════════════════════════════"
printf '%s\n' " 部署完成" "════════════════════════════════════════════"
printf '  控制台      %s:3000\n' "$PUBLIC_HOSTNAME"
printf '  xiaomusic   %s:8090\n' "$PUBLIC_HOSTNAME"
printf '  健康检查    curl -s http://127.0.0.1:3000/xiaomusic-playlist.json | head -c 200\n'
printf '\n  下一步（音箱端实测，必须做）：\n'
printf '    1) 对音箱说「播放歌单 周杰伦七里香」\n'
printf '    2) 对音箱说「播放晴天」（走 B 站兜底）\n'
printf '    3) 对音箱说「你是谁」（走大模型）\n'
printf '  安全组记得放行 TCP 8090（0.0.0.0/0），3000 建议只对自己 IP。\n'
if [ "$HOSTPORT" = "127.0.0.1" ] || [ "$HOSTPORT" = "localhost" ]; then
  printf '  %s注意：PUBLIC_HOSTNAME 是本机地址，音箱访问不到，必须填服务器公网 IP%s\n' "$Y" "$Z"
fi
