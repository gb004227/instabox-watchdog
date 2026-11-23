# 小爱音箱全栈上云 · 一键部署方案

> 目标：把原本依赖家里 Windows 电脑的三个服务（MiGPT 大模型控制台、xiaomusic 音源、网易云歌单直链代理）整体搬到云服务器，电脑关机后音箱照常能用。
> 交付目录：`cloud-deploy/`，一条 `bash deploy.sh` 拉起全部。

---

## 零、本次落实记录（2026-11-23）

### 已修掉的 3 个必炸问题

| # | 位置 | 原问题 | 后果 | 现在 |
|---|---|---|---|---|
| 1 | `deploy.sh` | `docker compose exec -e NETEASE_COOKIE` 读的是**宿主 shell 环境**，脚本从未 source `.env` | 歌单生成永远拿到空 Cookie，周杰伦专辑全空，只报一句"失败" | 改为 `getenv()` 从 `.env` 逐行解析后显式传入；**故意不 source**，因为 Cookie 含 `;` `=` `$`，source 会把 shell 搞坏 |
| 2 | `entrypoint-xiaomusic.sh` | `sed s\|__MI_PASS__\|$MI_PASS\|` 模板替换 | 密码含 `&` `\|` `\` 时 config.json 被写坏，容器起不来且报错难懂 | 改用 Python 读模板 + `json.dump`，已用 `p&a\|s$s\d"q` 实测原样保留 |
| 3 | `deploy.sh` 收尾 | `http://$(grep PUBLIC_HOSTNAME)` | 输出 `http://http://IP:3000` | 去掉重复协议头，并校验占位符未填写时直接报错 |

另外补齐的：`.dockerignore`（`.env` 不进构建上下文）、`bootstrap.sh`（裸机装 Docker + 2G swap）、
`data/playlist.json` 单独 bind mount（重建镜像不丢歌单）、`healthcheck`、`CONSOLE_BIND` 可配。

### 配置模板从"手写 48 键"升级为"本地 66 键全量"

原模板缺 18 个键，包括 `key_word_dict`（26 条语音指令词）、`keywords_play`、`keywords_playlist`、
`devices`、`enable_force_stop` 等。缺这些等于云端用的是 xiaomusic 内置默认词表，**你本地调过的唤醒词在云端不生效**。
现在直接从 `xiaomusic/config.json` 全量生成，只替换 5 个占位符 + `ffmpeg_location=/usr/bin`。

### 已验证 / 未验证

| 项目 | 状态 |
|---|---|
| 补丁 `patches/device_player.py` 与官方 wheel 0.6.1 的兼容性 | **已验证**：官方 1328 行 → 补丁 1343 行，`+15 / -0`，是严格超集，可直接覆盖 |
| `xiaomusic==0.6.1` wheel 里存在 `cli.py` / `device_player.py`，`--config` 参数存在 | **已验证**：下载 wheel 解包确认 |
| `/xiaomusic-playlist.json` 路由与 gen 脚本输出路径一致 | **已验证**：`server.mjs` 静态目录 = `public/`，gen 写 `public/xiaomusic-playlist.json` |
| `docker compose config` 渲染、挂载路径、`.env` 变量替换 | **已验证**（本机 docker CLI） |
| 全部 shell / node 脚本语法 | **已验证**（`bash -n` / `sh -n` / `node --check`） |
| 镜像能否构建成功、容器能否起来、音箱能否出声 | **未验证**：需要一台中国大陆云服务器，本机 Docker daemon 未运行 |

---

## 一、为什么能上云（先看懂再动手）

这套系统能整体搬迁，取决于一个关键事实：**xiaomusic 对音箱的控制走的是米家云端 API，不是局域网协议。**

| 环节 | 走哪条路 | 上云影响 |
|---|---|---|
| 监听你说话 | xiaomusic 轮询米家云端 `userprofile.mina.mi.com` 拉对话记录 | 云端可达，无影响 |
| 下发播放/暂停/TTS | mina_service（`player_pause` / `play_by_url` / `text_to_speech`） | 云端可达，无影响 |
| 音箱拿音频 | 音箱根据下发的 **公网 URL** 自己拉取音频流 | **关键**：URL 必须是公网可达地址 |
| 大模型对话 | MiGPT 调 OpenAI 兼容 API（DeepSeek）+ 米家云收发 | 云端可达，无影响 |

**唯一必须改的地方**：本地 `hostname` 写的是 `http://192.168.31.36`（家里电脑的私网 IP）。音箱在家里能访问，但云端部署后这个地址失效。云端必须把 `hostname` 改成**云服务器的公网 IP 或域名**，音箱才会去公网拉音频。这一步部署脚本已通过 `PUBLIC_HOSTNAME` 环境变量自动完成。

**两个必须知道的约束**：

1. **服务器地域**：必须选**中国大陆节点**（阿里云/腾讯云国内区）。网易云 CDN、B 站音频、米家 API 对境外 IP 有版权地域限制和风控，香港/海外节点会出现「解析失败 / 403 / 播放无声」。
2. **公网端口**：音箱要能直连服务器拉流，`8090` 端口必须在**安全组放行**（TCP，来源 0.0.0.0/0）。`3000` 是管理控制台，建议只对自己 IP 放行或走 SSH 隧道。

---

## 二、服务器要求

| 项目 | 最低 | 推荐 |
|---|---|---|
| 地域 | 中国大陆 | 离你家用宽带同省/邻近省（延迟低） |
| 配置 | 1 核 2G | 2 核 4G |
| 系统 | Ubuntu 22.04 / Debian 12 | Ubuntu 22.04 LTS |
| 磁盘 | 20G | 40G+（本地曲库缓存会增长） |
| 带宽 | 3 Mbps | 5 Mbps+（音乐 320k，多人同时播要更大） |
| 软件 | Docker 20+ / docker compose v2 | 一键脚本会自动检查 |
| 域名 | 可选 | 有域名 + HTTPS 反代体验更好（音箱对纯 IP 也支持） |

---

## 三、部署前准备（3 件事）

### 1. 安装 Docker（国内镜像加速）

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
docker compose version   # 确认 v2 插件存在
```

国内拉镜像慢可配 `/etc/docker/daemon.json` 的 registry-mirrors（阿里云/腾讯云镜像站），配完 `systemctl restart docker`。

### 2. 准备四个凭据

| 凭据 | 从哪拿 | 填到 .env 的哪个变量 |
|---|---|---|
| 小米账号 + 密码 | 你的小米 ID | `MI_USER` / `MI_PASS` |
| 大模型 API Key | DeepSeek 控制台 | `OPENAI_API_KEY` |
| 网易云 Cookie | music.163.com 登录后 F12 → Network → 任意请求 → Cookie 整段 | `NETEASE_COOKIE` |
| 公网 IP | `curl ifconfig.me` | `PUBLIC_HOSTNAME=http://你的IP` |

> 网易云 Cookie 会过期（通常几周到几个月）。过期后重新抓一次填进 `.env`，重启容器即可，歌单不用重新生成。

**这四项已从本地配置自动提取并写入包内 `.env`**：小米账号/密码取自 `xiaoai-migpt/config.js`，
DeepSeek key 同上，网易云 Cookie 取自 `xiaoai-migpt/netease.json`（2502 字节），音箱显示名
`MI_DID_NAME=Xiaomi 智能音箱 Pro` 也已带上。**你只需要改 `PUBLIC_HOSTNAME` 一项。**

### 3. 上传部署包

本地已打好包：`G:/Workbuddy项目输出/2026-10-30-21-51-41/xm-cloud-deploy.tar.gz`（131 KB，37 项，**含已预填凭据的 `.env`**）。

```bash
# 上传
scp xm-cloud-deploy.tar.gz root@服务器IP:/opt/
# 解包（解出来是 /opt/cloud-deploy）
ssh root@服务器IP 'cd /opt && tar xzf xm-cloud-deploy.tar.gz && chmod 600 cloud-deploy/.env'
```

包内已包含：`docker-compose.yml`、两个 `Dockerfile`、`deploy.sh`、`bootstrap.sh`、`entrypoint-*.sh`、
`xiaomusic-config.template.json`（66 键全量）、`patches/device_player.py`、`.env`、`.dockerignore`，
以及同步好的 `xiaoai-migpt/` 源码（已剔除 `node_modules`、`.mi.json`、日志）。

> `.env` 里含明文小米密码 / DeepSeek key / 网易云 Cookie。传完后 `rm xm-cloud-deploy.tar.gz`，别外发。

---

## 四、一键部署（核心步骤）

```bash
cd /opt/cloud-deploy
sed -i 's|REPLACE_WITH_SERVER_IP|你的公网IP|' .env    # 只需改这一处，其余凭据已预填
bash bootstrap.sh        # 裸机：装 Docker + 补 swap，再调 deploy.sh
# 已有 Docker 的机器：直接 bash deploy.sh
```

`deploy.sh` 依次做 6 件事：

1. 环境自检（docker / compose v2 / daemon / `.env` 必填项，缺一个立刻带修复命令退出）
2. 建 `data/{music,conf,playlist.json}` 数据目录
3. 同步 `../xiaoai-migpt` 源码到构建上下文（剔除 `node_modules` / `.mi.json` / 日志）
4. `docker compose build` 构建两个镜像
5. `docker compose up -d` 启动，轮询 `:3000` 直到就绪（最多 90 秒）
6. 在 console 容器内跑 `gen-netease-playlist.mjs` 生成歌单（显式传 Cookie），校验字节数/条数，再下发「刷新列表」

**首次构建约 3-8 分钟**（拉 Python/Node 基础镜像 + pip/npm 依赖）。完成后：

```bash
docker compose ps      # 两个服务都应 Up
docker compose logs -f # 看实时日志
```

---

## 五、验证（部署完必做）

### 1. 管理界面

- 浏览器打开 `http://服务器IP:3000` → MiGPT 控制台，能看到「状态：运行中」
- 浏览器打开 `http://服务器IP:8090` → xiaomusic 管理页，能看到设备列表和歌单

### 2. 直链代理链路

```bash
# 控制台应返回歌单 JSON
curl http://127.0.0.1:3000/xiaomusic-playlist.json | head -c 200

# 随便取一首歌的 url 测 302 解析（应返回 302 到 CDN 或 B 站）
curl -I "http://127.0.0.1:3000/netease-stream/<歌曲ID>?name=<歌名-歌手>"
```

### 3. 音箱实测（终极验证）

对音箱说：

- 「播放歌单 周杰伦七里香」——验证网络歌单 + 直链代理
- 「播放晴天」——验证 B 站兜底下载（周杰伦版权曲走 B 站）
- 「你是谁」——验证大模型对话

音箱能出声、控制台日志有 `netease-stream 302` / `play` 记录即全链路打通。

---

## 六、本地→云端改造清单（已做，供审阅）

为让同一套代码本地、云端都能跑，做了以下**向后兼容**改造（本地零影响，默认值不变）：

| 文件 | 改造 | 本地默认 | 云端覆盖 |
|---|---|---|---|
| `server.mjs` | yt-dlp 路径改环境变量 | WorkBuddy 内置 exe 路径 | `YTDLP_BIN=/usr/local/bin/yt-dlp` |
| `gen-netease-playlist.mjs` | 直链基础地址改环境变量 | `http://127.0.0.1:3000` | `STREAM_BASE=http://console:3000` |
| `gen-netease-playlist.mjs` | 网易云 uid 改环境变量 | `118428391` | `NETEASE_UID` |
| `config.js` | 小米账号/密码/did/token 改环境变量 | 原硬编码值 | `MI_USER/MI_PASS/MI_DID_NAME/MI_PASS_TOKEN` |
| `config.js` | 大模型 Key 改环境变量 | 原硬编码值 | `OPENAI_API_KEY` |
| `config.js` | xiaomusic 地址改环境变量 | `http://127.0.0.1:8090` | `XIAOMUSIC_URL=http://xiaomusic:8090` |
| `netease.mjs` | Cookie 支持环境变量优先 | 读 `netease.json` | `NETEASE_COOKIE` |
| `device_player.py`（patches/） | **保留本地 4 处 PATCH** | 已打补丁版 | 覆盖官方 wheel，防播放竞态 |

> **最容易踩的坑**：官方 `pip install xiaomusic==0.6.1` 的 wheel **不含**那 4 处 PATCH（B 站下载竞态、TTS 定时器判断）。不覆盖 `patches/device_player.py` 的话，云端会出现「音乐压过 TTS 被掐断 / 下载卡住」。部署文件已自动覆盖。

---

## 七、日常运维

```bash
# 查看状态
docker compose ps

# 看日志（排查首选）
docker compose logs -f console
docker compose logs -f xiaomusic

# 重启
docker compose restart

# 更新代码后重新构建
bash deploy.sh

# 网易云 cookie 过期：改 .env 里的 NETEASE_COOKIE，然后
docker compose up -d --force-recreate console

# 重新生成歌单（换账号 / 加歌手时）
docker compose exec -T -e NETEASE_COOKIE -e NETEASE_UID \
  -e STREAM_BASE=http://console:3000/netease-stream \
  console node gen-netease-playlist.mjs
docker compose exec -T xiaomusic sh -c 'curl -s -X POST http://127.0.0.1:8090/cmd -H "Content-Type: application/json" -d "{\"did\":\"\",\"cmd\":\"刷新列表\"}"'

# 数据备份（曲库 + 配置 + 歌单，都在 data/ 里）
docker compose down && tar czf xm-backup-$(date +%F).tgz data .env && docker compose up -d
```

---

## 八、安全加固（建议做）

1. **控制台别裸奔**：3000 端口只对自己 IP 放行：
   ```bash
   iptables -I INPUT -p tcp --sport 3000 -j DROP   # 或用云安全组限定来源 IP
   ```
   更稳的是用 SSH 隧道：`ssh -L 3000:127.0.0.1:3000 root@服务器`，本地访问 `http://127.0.0.1:3000`。
2. **8090 必须公网**（音箱要拉流），但 xiaomusic 已默认 `disable_httpauth=true` 且只暴露必要接口；如担心可改 `httpauth_username/password` 并同步音箱侧配置（会影响拉流，谨慎）。
3. **HTTPS 反代**（可选）：用 Nginx + Let's Encrypt 把 `PUBLIC_HOSTNAME` 换成 `https://你的域名`，音箱同样支持。
4. **凭据只进 .env**：`.gitignore` 已排除；不要把 `.env`、Cookie、API Key 提交到任何仓库。

---

## 九、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 音箱播放无声 / 403 | `PUBLIC_HOSTNAME` 填错或 8090 未放行 | 确认填公网 IP 且安全组开 8090；`curl http://IP:8090` 能通 |
| 周杰伦的歌解析失败 | 网易云灰名单，走 B 站兜底 | 看 console 日志有无 `yt-dlp`；确认容器内 yt-dlp 可用 |
| 提示小米登录风控 | 异地登录触发 | `.env` 填 `MI_PASS_TOKEN`（从账号 Cookie 提取 passToken） |
| 歌单是空的 | gen 脚本没跑或 Cookie 过期 | 重跑第七节「重新生成歌单」 |
| 音乐被 TTS 掐断 | device_player.py 补丁丢失 | 确认 `patches/device_player.py` 已 COPY 进镜像，重建 |
| 境外/香港节点播放异常 | 版权地域限制 | 换中国大陆节点 |
| 容器起不来 | `.env` 没填或格式错 | `docker compose config` 检查，看 `docker compose logs` |
| 构建阶段卡死 / 进程被 kill | 2G 内存机器 npm/pip 构建 OOM | `bash bootstrap.sh` 已自动建 2G swap；或手动 `swapon` 后重跑 |
| `entrypoint: 环境变量 MI_USER 未设置` | compose 没读到 `.env` | 确认在 `cloud-deploy/` 目录执行；`docker compose config \| grep MI_USER` |
| 歌单 404 或 `{}` | gen 脚本没跑成 / Cookie 过期 | `wc -c data/playlist.json` 应为几十万字节；重跑第六节命令 |
| 音箱能控制但没声音 | `PUBLIC_HOSTNAME` 不是公网地址，或 8090 未放行 | `curl -I http://公网IP:8090/` 应返回 200 |

---

## 十、回滚

云端出问题想退回本地方案：

1. 云上 `docker compose down` 停服；
2. 本地按原方式启动（`start.bat` + `node server.mjs`）；
3. 本地 xiaomusic 的 `hostname` 仍是 `http://192.168.31.36`，歌单 `STREAM_BASE` 默认 `127.0.0.1:3000`，与改造后的代码默认值一致，直接可用。

双向无损，随时切。

---

## 十一、架构总览

```
            ┌────────────── 云服务器（中国大陆，公网 IP）──────────────┐
            │                                                        │
音箱 ──①听──→│  mina 云端轮询  ←── 米家云 API ──→ 音箱                  │
            │       │                                                │
            │       ↓ ②「播放XX」                                     │
            │  ┌──────────────┐  ③HTTP  │  ┌──────────────────────┐  │
            │  │ xiaomusic    │←──────────→│ console (MiGPT)      │  │
            │  │ :8090        │ 网络歌单   │ :3000                │  │
            │  │ 补丁版播放   │           │ 网易云直链代理 302    │  │
            │  └──────┬───────┘           │ DeepSeek 大模型       │  │
            │         │ ④下发公网音频URL   └──────────┬───────────┘  │
            └─────────┼──────────────────────────────┼──────────────┘
                      ↓ 音箱直连拉流                  ↓
               http://公网IP:8090/proxy      网易云CDN / B站音频
```

- ①③④ 全在云端完成 → 电脑关机无影响
- 音箱始终通过 `PUBLIC_HOSTNAME` 访问服务器，这是上云后唯一需要重配的地址

---

*方案与部署文件位置：`G:/Workbuddy项目输出/2026-10-30-21-51-41/cloud-deploy/`*
