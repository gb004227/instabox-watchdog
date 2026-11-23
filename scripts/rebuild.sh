#!/usr/bin/env bash
# 一键修复 / 重装 —— 机器被暂停、容器挂了、或者数据被清空时用它
#
# 默认行为：只在服务真的不健康时才动手，幂等，可以反复跑。
#   FORCE_REBUILD=1  强制重新构建镜像
#   WIPE_DATA=1      删掉 /data/xmcloud 从零重装（会丢歌单，不丢小米登录态）
set -uo pipefail

API="${INSTABOX_API_URL:-https://api.instabox.sh}"
KEY="${INSTABOX_API_KEY:?缺少 INSTABOX_API_KEY}"
MACHINE="${INSTABOX_MACHINE:-box-1}"
DIR=/data/xmcloud
FORCE_REBUILD="${FORCE_REBUILD:-0}"
WIPE_DATA="${WIPE_DATA:-0}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local -a a=(-sS -m 90 -X "$method" "$API$path" -H "X-API-Key: $KEY" -H "Accept: application/json")
  [ "$method" != "GET" ] && a+=(-H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)")
  [ -n "$body" ] && a+=(-H "Content-Type: application/json" -d "$body")
  curl "${a[@]}"
}

jget() { python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for k in sys.argv[1].split("."):
    if isinstance(d,dict) and k in d: d=d[k]
    else: print(""); raise SystemExit
print("" if d is None else d)
' "$1"; }

# 执行一条命令，返回 stdout（exec 是同步调用，直接给结果）
rexec() {
  local cmd="$1" payload resp
  payload=$(python3 -c '
import json,sys
print(json.dumps({"cmd": sys.argv[1]}))
' "$cmd")
  resp=$(api POST "/v1/machines/$MACHINE/exec" "$payload")
  local err
  err=$(printf '%s' "$resp" | jget error.code)
  if [ -n "$err" ]; then
    printf '[exec错误] %s\n' "$(printf '%s' "$resp" | jget error.message)" >&2
    return 1
  fi
  printf '%s' "$resp" | jget stdout
}

# ---------- 0. 保证机器在跑 ----------
log "=== [0/5] 确认机器状态 ==="
M=$(api GET "/v1/machines/$MACHINE")
STATE=$(printf '%s' "$M" | jget state)
log "state=$STATE"
if [ "$STATE" != "running" ]; then
  # 实测：suspended 状态下 wake 会报 machine_not_running，必须用 start
  log "→ start"
  R=$(api POST "/v1/machines/$MACHINE/start")
  CODE=$(printf '%s' "$R" | jget error.code)
  if [ "$CODE" = "machine_cooldown" ]; then
    log "仍在冷却（还剩 $(printf '%s' "$R" | jget error.retryAfterSeconds) 秒），稍后再试"
    exit 0
  fi
  if [ -n "$CODE" ]; then
    log "start 失败（$CODE），改试 wake"
    R=$(api POST "/v1/machines/$MACHINE/wake")
    CODE=$(printf '%s' "$R" | jget error.code)
    [ -n "$CODE" ] && { log "wake 也失败（$CODE），退出"; exit 1; }
  fi
  op=$(printf '%s' "$R" | jget id)
  [ -n "$op" ] && api GET "/v1/operations/$op?wait=25s" >/dev/null
  sleep 10
  STATE=$(api GET "/v1/machines/$MACHINE" | jget state)
  log "现在 state=$STATE"
  [ "$STATE" != "running" ] && { log "未能进入 running，退出"; exit 1; }
fi

# ---------- 1. 数据目录 ----------
log "=== [1/5] 检查 $DIR ==="
HAS_DIR=$(rexec "test -d $DIR && echo YES || echo NO" | tr -d '\r' | tail -1)
log "目录存在: $HAS_DIR"

if [ "$WIPE_DATA" = "1" ] && [ "$HAS_DIR" = "YES" ]; then
  log "WIPE_DATA=1 → 删除 $DIR"
  rexec "cd $DIR && docker compose down -v 2>/dev/null; cd / && rm -rf $DIR && echo wiped"
  HAS_DIR=NO
fi

if [ "$HAS_DIR" != "YES" ]; then
  log "数据目录不存在 → 需要从仓库重装。"
  log "请先运行 workflow_dispatch 的 restore 任务（会用 Secrets 里的配置重建），或手动上传 cloud-deploy。"
  exit 2
fi

# ---------- 2. 小米登录态 ----------
log "=== [2/5] 检查登录态 ==="
AUTH_STATE=$(rexec "test -s $DIR/data/conf/auth.json && echo AUTH_OK || echo AUTH_MISSING" | tr -d '\r' | tail -1)
log "$AUTH_STATE"
if [ "$AUTH_STATE" = "AUTH_MISSING" ] && [ -n "${XIAOMUSIC_AUTH_B64:-}" ]; then
  log "从 Secret 恢复 auth.json"
  rexec "mkdir -p $DIR/data/conf && printf '%s' '$XIAOMUSIC_AUTH_B64' | base64 -d > $DIR/data/conf/auth.json && chmod 600 $DIR/data/conf/auth.json && echo restored"
fi

# ---------- 3. 起服务 ----------
log "=== [3/5] 启动容器 ==="
if [ "$FORCE_REBUILD" = "1" ]; then
  log "FORCE_REBUILD=1 → 重新构建"
  rexec "cd $DIR && docker compose up -d --build 2>&1 | tail -20"
else
  rexec "cd $DIR && mkdir -p data/music data/conf data/migpt && docker compose up -d 2>&1 | tail -20"
fi

# ---------- 4. 等就绪 ----------
log "=== [4/5] 等待服务就绪（最多 120 秒）==="
ok=0
for i in $(seq 1 12); do
  sleep 10
  st=$(rexec "curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/ ; echo; curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8090/" | tr -d '\r' | tr '\n' ' ')
  log "  第 ${i} 次探测: $st"
  case "$st" in
    "200 200"*) ok=1; break ;;
  esac
done

# ---------- 5. 结果 ----------
log "=== [5/5] 结果 ==="
rexec "cd $DIR && docker compose ps --format '{{.Name}} {{.State}}'"
if [ "$ok" = "1" ]; then
  log "服务已就绪：3000 控制台 + 8090 音乐，均返回 200"
  exit 0
else
  log "服务未在预期时间内就绪，请查看容器日志："
  rexec "cd $DIR && docker compose logs --tail 30 2>&1 | tail -30"
  exit 1
fi
