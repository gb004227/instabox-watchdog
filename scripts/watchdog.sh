#!/usr/bin/env bash
# instabox 云端看门狗 —— 跑在 GitHub Actions（或任意 Linux），不需要你的电脑开机
#
# 每轮做四件事：
#   1. 机器被暂停/停止 → wake / start
#   2. 撞上 cooldown → 记下来，下轮再来（冷却期内所有唤醒路径都被拒绝）
#   3. 运行中且快到 480 分钟上限 → 主动 suspend + wake，计时器归零，无冷却
#   4. 运行中且未到阈值 → 打一次 exec 确认服务活着
#
# 关键依据（官方文档）：
#   "The next wake starts a fresh run, so the maximum runtime is counted again from that wake."
#   "An idle pause has no cooldown on any plan."
#   "The count starts over when a run ends with no cooldown owed (an idle pause, or you pause or stop the machine)."
set -uo pipefail

API="${INSTABOX_API_URL:-https://api.instabox.sh}"
KEY="${INSTABOX_API_KEY:?缺少 INSTABOX_API_KEY}"
MACHINE="${INSTABOX_MACHINE:-box-1}"

# 主动重启的阈值 = maxRunMinutes - LEAD_MIN（自动读 API，不写死）
# 免费计划 maxRunMinutes 会从 120 往上长，写死 300 会在 120 上限时被真暂停，故改成动态。
LEAD_MIN="${LEAD_MIN:-20}"          # 上限前提前多少分钟重置（留足 cron 延迟余量）
RESET_AFTER_MIN="${RESET_AFTER_MIN:-}"   # 手动指定则优先（调试用）
# 重启后等待服务恢复的秒数（容器 + xiaomusic 登录）
SETTLE_SEC="${SETTLE_SEC:-90}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# ---------- API 基础 ----------
# $1=method $2=path [$3=body]
api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS -m 60 -X "$method" "$API$path"
                 -H "X-API-Key: $KEY"
                 -H "Accept: application/json")
  if [ "$method" != "GET" ]; then
    # 变更类请求必须带幂等键
    args+=(-H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)")
  fi
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}"
}

# 从 JSON 里取字段，取不到返回空
jget() { python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
for k in sys.argv[1].split("."):
    if isinstance(d,dict) and k in d: d=d[k]
    else: print(""); raise SystemExit
print("" if d is None else d)
' "$1"; }

# 轮询操作直到结束。注意：Operation 的字段名是 state（不是 status）
wait_op() {
  local op_id="$1" rounds="${2:-12}"
  [ -z "$op_id" ] && return 0
  local i st phase
  for i in $(seq 1 "$rounds"); do
    st=$(api GET "/v1/operations/$op_id?wait=25s")
    phase=$(printf '%s' "$st" | jget state)
    [ -z "$phase" ] && phase=$(printf '%s' "$st" | jget status)
    case "$phase" in
      succeeded) log "  operation $op_id -> succeeded"; return 0 ;;
      failed|canceled) log "  operation $op_id -> $phase"; return 1 ;;
      queued|running|"") sleep 2 ;;
      *) log "  operation $op_id -> $phase"; return 1 ;;
    esac
  done
  log "  operation $op_id 超时未完成"
  return 1
}

# 触发一个变更并等它完成
trigger() {
  local action="$1" resp code op_id
  resp=$(api POST "/v1/machines/$MACHINE/$action")
  code=$(printf '%s' "$resp" | jget error.code)
  case "$code" in
    "") : ;;
    machine_cooldown)
      local secs
      secs=$(printf '%s' "$resp" | jget error.retryAfterSeconds)
      log "  冷却中，还剩 ${secs:-?} 秒，本轮放弃"
      return 42 ;;
    *)
      log "  $action 失败: $(printf '%s' "$resp" | head -c 300)"
      return 1 ;;
  esac
  op_id=$(printf '%s' "$resp" | jget id)
  wait_op "$op_id"
}

# ---------- 主流程 ----------
log "=== 检查 $MACHINE ==="
M=$(api GET "/v1/machines/$MACHINE")
STATE=$(printf '%s' "$M" | jget state)
[ -z "$STATE" ] && die "拿不到机器状态，原始响应: $(printf '%s' "$M" | head -c 300)"

RUN_STARTED=$(printf '%s' "$M" | jget runStartedAt)
COOLDOWN=$(printf '%s' "$M" | jget cooldownUntil)
MAXRUN=$(printf '%s' "$M" | jget maxRunMinutes)

log "state=$STATE maxRunMinutes=$MAXRUN runStartedAt=${RUN_STARTED:-null} cooldownUntil=${COOLDOWN:-null}"

# 1. 冷却期：什么都做不了，直接退出
if [ -n "$COOLDOWN" ] && [ "$COOLDOWN" != "null" ]; then
  now=$(date -u +%s)
  until=$(date -u -d "$COOLDOWN" +%s 2>/dev/null || echo 0)
  if [ "$until" -gt "$now" ]; then
    left=$(( (until - now) / 60 ))
    log "冷却中，约 ${left} 分钟后可唤醒。本轮结束。"
    exit 0
  fi
  log "冷却已过（cooldownUntil=$COOLDOWN），尝试恢复"
fi

# 2. 非运行态：恢复。
#    实测：对 suspended 的机器调 wake 会报 machine_not_running（"start it first"），
#    恢复暂停/停止的机器必须用 start。
case "$STATE" in
  running) : ;;
  suspended|suspending|stopped|stopping)
    log "机器是 $STATE → start 恢复"
    if trigger start; then
      sleep 5
    else
      rc=$?
      [ "$rc" = "42" ] && exit 0
      log "  start 失败，改试 wake"
      trigger wake || exit $?
      sleep 5
    fi
    ;;
  starting|resuming|creating)
    log "机器正在启动中，本轮不干预"
    exit 0
    ;;
  *)
    log "未知状态 $STATE → 先试 start"
    trigger start || trigger wake || exit $?
    sleep 5
    ;;
esac

# 重新读状态
M=$(api GET "/v1/machines/$MACHINE")
STATE=$(printf '%s' "$M" | jget state)
RUN_STARTED=$(printf '%s' "$M" | jget runStartedAt)
log "现在 state=$STATE runStartedAt=${RUN_STARTED:-null}"

if [ "$STATE" != "running" ]; then
  log "仍未进入 running（$STATE），下轮再试"
  exit 0
fi

# 3. 计算已运行时长，决定是否主动重置计时器
ELAPSED=0
if [ -n "$RUN_STARTED" ] && [ "$RUN_STARTED" != "null" ]; then
  start_ts=$(date -u -d "$RUN_STARTED" +%s 2>/dev/null || echo 0)
  now_ts=$(date -u +%s)
  if [ "$start_ts" -gt 0 ]; then
    ELAPSED=$(( (now_ts - start_ts) / 60 ))
  fi
fi
log "本次 run 已运行 ${ELAPSED} 分钟"

# 阈值：优先用环境变量，否则 maxRunMinutes - LEAD_MIN
THRESH=""
if [ -n "$RESET_AFTER_MIN" ]; then
  THRESH="$RESET_AFTER_MIN"
elif [ -n "$MAXRUN" ] && [ "$MAXRUN" != "null" ]; then
  THRESH=$(( MAXRUN - LEAD_MIN ))
  [ "$THRESH" -lt 5 ] && THRESH=$(( MAXRUN / 2 ))
else
  THRESH=100
fi
log "重置阈值 = ${THRESH} 分钟（maxRunMinutes=${MAXRUN:-?} 上限前留 ${LEAD_MIN} 分钟）"

if [ "$ELAPSED" -ge "$THRESH" ]; then
  log "达到阈值 → 主动 suspend + start 重置计时器（不产生冷却）"
  if trigger suspend; then
    # 等真正停下来
    for i in $(seq 1 12); do
      s=$(api GET "/v1/machines/$MACHINE" | jget state)
      [ "$s" = "suspended" ] || [ "$s" = "stopped" ] && break
      sleep 5
    done
    log "当前 state=$(api GET "/v1/machines/$MACHINE" | jget state) → start 恢复"
    trigger start || die "重置后恢复失败，机器处于离线状态，需要人工介入"
    log "恢复完成，等 ${SETTLE_SEC} 秒让 systemd 自启容器"
    sleep "$SETTLE_SEC"
  else
    rc=$?
    [ "$rc" = "42" ] && exit 0
    die "suspend 失败，本轮不强行恢复（避免半截状态）"
  fi

  # 唤醒后确认服务
  M=$(api GET "/v1/machines/$MACHINE")
  log "重置后 state=$(printf '%s' "$M" | jget state) runStartedAt=$(printf '%s' "$M" | jget runStartedAt)"
fi

# 4. 健康检查：一条轻量 exec（同步返回 stdout），确认容器还活着
HEALTH_CMD='cd /data/xmcloud 2>/dev/null && docker compose ps --format "{{.Name}}:{{.State}}" 2>/dev/null | tr "\n" " " || echo NO_DIR'
HEALTH=$(api POST "/v1/machines/$MACHINE/exec" "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1]}))' "$HEALTH_CMD")")
OUT=$(printf '%s' "$HEALTH" | jget stdout)
ERR=$(printf '%s' "$HEALTH" | jget error.code)
log "容器状态: ${OUT:-（空输出）}"

# 4b. 服务不完整 → 自动把整套服务装回去（幂等，容器已在跑时是空操作）
need_fix=0
case "$OUT" in
  *xm-console:running*) : ;;
  *) need_fix=1 ;;
esac
case "$OUT" in
  *xm-music:running*) : ;;
  *) need_fix=1 ;;
esac
[ -n "$ERR" ] && log "exec 失败（$ERR），跳过自愈"

if [ "$need_fix" = "1" ] && [ -z "$ERR" ]; then
  log "服务不完整 → 自动重装（docker compose up -d）"
  FIX=$(api POST "/v1/machines/$MACHINE/exec" "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1]}))' 'cd /data/xmcloud && docker compose up -d 2>&1 | tail -5')")
  log "  up: $(printf '%s' "$FIX" | jget stdout | tr '\n' ' ' | head -c 300)"
  # 等就绪（最多 150 秒）
  ok=0
  for i in $(seq 1 15); do
    sleep 10
    P=$(api POST "/v1/machines/$MACHINE/exec" "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1]}))' 'curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:8090/ ; echo -n " " ; curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:3000/"')")
    CODES=$(printf '%s' "$P" | jget stdout | tr -d '\r\n')
    log "  探测[$i]: ${CODES:-?}"
    case "$CODES" in
      "200 200"*) ok=1; break ;;
    esac
  done
  if [ "$ok" = "1" ]; then
    log "自动重装完成：8090 与 3000 均 200"
  else
    log "自动重装后仍未就绪，需要人工看日志：docker compose logs --tail 50"
  fi
fi

log "=== 完成 ==="
