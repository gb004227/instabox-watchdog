# instabox 保活 · 小爱音箱云端部署

用 GitHub Actions 定时任务（每 5 分钟）让 `box-1` 在撞上运行时长上限之前主动重置计时器，从不停机过久；容器掉了或机器被暂停过，会**自动把整套小爱音箱服务装回去**。

## 原理：主动重置计时器

免费计划的硬限制是「一次 run 最长 `maxRunMinutes` 分钟」（**实测当前是 120 分钟**，会随使用往上涨，上限 480），但官方文档写明：

> "The next wake starts a fresh run, so the maximum runtime is counted again from that wake."
>
> "An idle pause has no cooldown on any plan."
> "The count starts over when a run ends with no cooldown owed (**an idle pause, or you pause or stop the machine**)."

所以策略不是「等它撞上限再救」，而是 **跑到 `maxRunMinutes - LEAD_MIN`（默认 120-20=100 分钟）就主动 `suspend` + `start`**。
阈值是从 API 读 `maxRunMinutes` 现算的，**不要写死 300** —— 上限还是 120 的时候，写死 300 会让机器在 120 分被平台真暂停并带冷却。

- 计时器归零（实测 `runStartedAt` 立即更新，`maxRunMinutes` 回到 120 并随使用再涨到 480）
- **不产生任何冷却**（实测 `cooldownUntil=null`）
- 顺带把「连续 max-run 暂停」的阶梯计数清零

代价是每次重启约 **80 秒**服务中断（实测 08:16:50 → 08:18:10 容器全部恢复）。

## 实测数据（2026-11-23）

| 项 | 结果 |
|---|---|
| 重置触发（Actions 实跑） | `已运行 1 分钟 ≥ 阈值 0`（手动 reset_now）→ suspend |
| suspend | `op_agraphyh2... -> succeeded` |
| start | `op_agraphysy... -> succeeded` |
| 计时器 | `08:54:42Z` → `08:56:35Z`，`runStartedAt` 归零 |
| 冷却 | `cooldownUntil=null` |
| 服务恢复 | 90 秒后 `xm-console:running xm-music:running` |
| 自愈（手动 `docker compose stop xiaomusic` 后） | `服务不完整 → 自动重装` → 11 秒后 `探测[1]: 200 200` |
| 端口 | `3000=200` `8090=200` |

## ⚠️ 踩过的坑

1. **恢复暂停的机器必须用 `start`，不是 `wake`。**
   对 `suspended` 状态调 `wake` 返回 `machine_not_running: "machine is suspended; start it first"`。

2. **Operation 的状态字段是 `state`，不是 `status`。**
   用 `status` 判定会永远读不到 `succeeded`，导致轮询空转到超时。

3. **变更类接口只认 machine id，用名字会 `not_found machine not found`。**
   `GET /v1/machines/box-1` 可以用名字，但 `POST /v1/machines/box-1/suspend` 会 404。
   脚本里先 `GET` 一次拿到 `id`，后面所有调用都换成 id。

4. **exec 的 `cmd` 不要内联嵌套引号。**
   远端是 `eval` 执行，`"$(...)"` 里再塞 `-w "%{http_code}"` 会报
   `bash: eval: line 1: unexpected EOF while looking for matching '"'`。
   先赋给变量（`PROBE_CMD='...'`）再传 `"$PROBE_CMD"` 就没事。

5. **`.gitattributes` 必须把 `*.sh` 钉成 LF。**
   Windows 上提交 CRLF 的脚本，Linux runner 上 bash 会报 `$'\r': command not found`。

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
| `LEAD_MIN` | `20` | 在上限前多少分钟触发重置（阈值 = `maxRunMinutes - LEAD_MIN`） |
| `SETTLE_SEC` | `90` | 重置后等服务自启的秒数 |

调试用的 `RESET_AFTER_MIN`（直接指定绝对阈值，`0` = 立刻重置）优先级更高，**平时不要设**。

### 4. 启用

**不要依赖 `schedule` 定时器。** 实测本仓库的 `schedule` 触发器**完全不执行**：
`cron-probe.yml`（内容只有一行 echo）从 08:53 挂到 09:44，跨过 8 个 `*/5` 时间点，`event=schedule` 的运行数一直是 **0**。
换成自接力模式：

| 工作流 | 触发 | 作用 |
|---|---|---|
| `watchdog-loop.yml` | 手动 + `0 */6 * * *` 兜底 | **真正的 worker**。一棒跑 5 小时 40 分，内部每 5 分钟跑一次 watchdog，跑完用自己的 `CHAIN_TOKEN` 派发下一棒 |
| `keepalive.yml` | 仅手动 | 单次检查 / 强制重置，调试用 |
| `rebuild.yml` | 仅手动 | 强制重建镜像或清盘重装 |
| `keepalive-alive.yml` | 每周 | 保活提交（schedule 不生效时这个也不会跑，但自接力用的是 dispatch，不受 60 天禁用影响） |

所以需要 **第三个 Secret**：

| Secret | 说明 |
|---|---|
| `CHAIN_TOKEN` | 带 `repo` + `workflow` 权限的 PAT，只用于「跑完派发下一棒」。链条断了的唯一补救就是手动点一次 `Run workflow` |

### 5. 启动链条

```bash
gh workflow run watchdog-loop.yml --repo <owner>/<repo>
```

之后它会自己接下去，不需要再管。

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

- **GitHub `schedule` 在本仓库 100% 不触发**（已用 `cron-probe.yml` 证伪，不是延迟）。因此设计成自接力：靠 `workflow_dispatch` 一棒接一棒。
- **自接力的断点**：如果某一棒的最后一 step 三次派发都失败（`HTTP 204` 才算成功），链条就断了，机器会在 120 分钟后被平台暂停、进入冷却。补救：手动 `Run workflow` 一次。
- **单棒上限**：GitHub 单个 job 最长 6 小时。这里跑 5 小时 40 分（`END = now + 20400`），`timeout-minutes: 355`。
- **单棒内的精度**：循环里每 5 分钟一轮，不受 GitHub cron 抖动影响，重置点能卡得很准（100 分钟阈值）。
- **60 天无活动会自动禁用** scheduled workflow。`keepalive-alive.yml` 每周自动提交一次空的 `last-active` 文件用来续命。
- **机器被删除后不适用**：新机器有新的 `m_xxx` id，公网 URL 也会变（`8090-<id>.instabox.tech`），需要人工重新 `port publish` 并更新 `.env` 的 `MUSIC_PUBLIC_URL` / `CONSOLE_PUBLIC_URL`。
- **成本**：public 仓库的 Actions 免费；private 仓库每 5 分钟一次约消耗 1400~1800 分钟/月，接近 2000 分钟上限。
