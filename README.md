# instabox 保活 · 小爱音箱云端部署

用 GitHub Actions 定时任务让 `box-1` 永不因 480 分钟上限掉线，并在服务异常时自动修复。

## 原理：主动重置计时器

免费计划的硬限制是「一次 run 最长 480 分钟」，但官方文档写明：

> "The next wake starts a fresh run, so the maximum runtime is counted again from that wake."
>
> "An idle pause has no cooldown on any plan."
> "The count starts over when a run ends with no cooldown owed (**an idle pause, or you pause or stop the machine**)."

所以策略不是「等它撞上限再救」，而是 **跑到 300 分钟就主动 `suspend` + `start`**：

- 计时器归零（实测 `runStartedAt` 立即更新，`maxRunMinutes` 回到 120 并随使用再涨到 480）
- **不产生任何冷却**（实测 `cooldownUntil=null`）
- 顺带把「连续 max-run 暂停」的阶梯计数清零

代价是每次重启约 **80 秒**服务中断（实测 08:16:50 → 08:18:10 容器全部恢复）。

## 实测数据（2026-11-23）

| 项 | 结果 |
|---|---|
| 重置触发 | `elapsed=1m ≥ threshold` → suspend |
| suspend | `operation op_agrao6v... -> succeeded` |
| start | `operation op_agrao6vs... -> succeeded` |
| 计时器 | `03:50:17Z` → `08:16:51Z`，`maxRunMinutes` 480 → **120** |
| 冷却 | `cooldownUntil=null` |
| 服务恢复 | 70 秒后 `xm-console:running xm-music:running` |
| 端口 | `3000=200` `8090=200` |

## ⚠️ 两个踩过的坑

1. **恢复暂停的机器必须用 `start`，不是 `wake`。**
   对 `suspended` 状态调 `wake` 返回 `machine_not_running: "machine is suspended; start it first"`。

2. **Operation 的状态字段是 `state`，不是 `status`。**
   用 `status` 判定会永远读不到 `succeeded`，导致轮询空转到超时。

## 部署

### 1. 创建仓库

推这个目录到你的 GitHub（public 仓库的 Actions 不消耗免费额度，private 仓库每月 2000 分钟，每 5 分钟一次的频率会吃紧）。

### 2. 配置 Secrets

`Settings → Secrets and variables → Actions`：

| Secret | 说明 |
|---|---|
| `INSTABOX_API_KEY` | `ibk_...`，dashboard → API keys 创建，需 `machines:read` + `machines:write` |
| `XIAOMUSIC_AUTH_B64` | 可选。`auth.json` 的 base64，用于登录态丢失时恢复 |

### 3. 配置 Variables（可选，有默认值）

| Variable | 默认 | 说明 |
|---|---|---|
| `INSTABOX_MACHINE` | `box-1` | 机器名或 `m_xxx` id |
| `RESET_AFTER_MIN` | `300` | 跑多少分钟触发重置。上限 480，留余量 |
| `SETTLE_SEC` | `90` | 重置后等服务自启的秒数 |

### 4. 启用

Actions 页面确认 `instabox keepalive` 已启用。可以点 `Run workflow` 手动跑一次，勾选 `reset_now` 立刻验证一次完整重置。

## 维护

```bash
# 手动跑一次（在 Actions 页面点 Run workflow 等效）
INSTABOX_API_KEY=ibk_xxx INSTABOX_MACHINE=box-1 bash scripts/watchdog.sh

# 强制立刻重置
RESET_AFTER_MIN=0 bash scripts/watchdog.sh

# 修复服务
bash scripts/rebuild.sh
```

## 已知边界

- **GitHub cron 会延迟**：`*/5 * * * *` 实际可能晚 5~15 分钟。阈值设 300 而不是 470，就是为这个延迟留的余量。
- **60 天无活动会自动禁用** scheduled workflow。`keepalive-alive.yml` 每周自动提交一次空的 `last-active` 文件用来续命。
- **机器被删除后不适用**：新机器有新的 `m_xxx` id，公网 URL 也会变（`8090-<id>.instabox.tech`），需要人工重新 `port publish` 并更新 `.env` 的 `MUSIC_PUBLIC_URL` / `CONSOLE_PUBLIC_URL`。
- **成本**：public 仓库的 Actions 免费；private 仓库每 5 分钟一次约消耗 1400~1800 分钟/月，接近 2000 分钟上限。
