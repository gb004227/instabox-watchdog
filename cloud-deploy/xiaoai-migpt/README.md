# 小爱音箱改造 —— Xiaomi 智能音箱 Pro (MiAiSoundbox-OH2P)

基于 [idootop/migpt-next](https://github.com/idootop/migpt-next)，把这台音箱的「小爱同学」接管给大模型。

## 一、你已经踩对了型号

`MiAiSoundbox-OH2P` 就是 **Xiaomi 智能音箱 Pro**（2025-02 发布，`xiaomi.wifispeaker.oh2p`，内置超级小爱）。
在项目官方兼容表里它属于 **✅ 完美运行** 档，而且是**项目作者本人用这台机器测出来的**：

| 参数 | 值 |
| --- | --- |
| ttsCommand | `[7, 3]` |
| wakeUpCommand | `[7, 1]` |
| streamResponse | `true` |

> migpt-next 已把 `ttsCommand` 从配置里移除（内置自动适配），所以 `config.js` 里不用填。

## 二、关于你给的 IP：192.168.31.185

已经验证设备在线（ping 2ms，同局域网）。但 **MiGPT 用不到这个 IP**，原因看代码就清楚：

`@mi-gpt/miot` 的音量、暂停、TTS 全部走 `callUbus()`，实际请求的是 MiNA **云端**接口
`userprofile.mina.mi.com/remote/ubus`（带 serviceToken 的 cookie）——不需要设备 token，
不需要局域网，**运行 MiGPT 的机器和音箱不在同一个网段也完全能跑**（放到云服务器/NAS 上都行）。

所以 IP 只在你想做局域网侧抓包、或以后走 `open-xiaoai` 刷机方案时才用得上。

## 三、跑起来（3 步）

### 1. 拿小米 ID

浏览器登录 <https://account.xiaomi.com> → 右上角头像 → 「个人信息」→ **小米 ID**（一串数字）。
注意不是手机号、不是邮箱。

### 2. 填配置

编辑 `config.js`：

```js
speaker: {
  userId: "你的小米ID",
  password: "账号密码",
  did: "Xiaomi 智能音箱 Pro",   // 米家 App 里显示的设备名，必须一字不差
},
openai: {
  model: "gpt-4.1-mini",
  baseURL: "https://api.openai.com/v1",  // 兼容 OpenAI 协议即可（DeepSeek/通义/Kimi/Ollama 都行）
  apiKey: "sk-xxx",
},
```

不确定 `did` 填什么？先跑这个，它会把账号下所有小爱设备的名字打出来：

```bash
node devices.mjs
```

### 3. 启动

```bash
npm start
```

Windows 也可以直接双击 `start.bat`（会自动装依赖）。

## 四、Web 控制台（推荐）

双击 `start.bat`，或执行 `npm start`，浏览器会自动打开 <http://127.0.0.1:3000>。

**界面能做什么：**

| 区域 | 作用 |
| --- | --- |
| 顶部状态栏 | 绿色呼吸灯＝正在监听；显示设备名和运行时长 |
| 中间对话流 | 实时显示「你说了什么」和「大模型回了什么」，带时间和播报耗时；鼠标悬停可复制回答 |
| `↳ 由小爱原生处理` | 3 秒内没有大模型回答，说明这句没命中关键词，由小爱自己答的 |
| 底部运行日志 | 点一下展开，能看到 `打断原生播报`、`播报返回 true` 等底层动作 |
| 右侧配置面板 | 在线改模型、Base URL、API Key、提示词、关键词、轮询间隔 |

**改配置不用重启进程。** 点「保存并重启」后，`server.mjs` 会写入 `runtime.json` 并热重启轮询循环，网页不会掉线，几秒内新模型就生效。

**三级验证按钮，从便宜到贵：**

- 「让音箱念一句」→ 只验证出声链路（云端 ubus → 音箱），不消耗 token
- 「测试连接」→ 用当前表单里的配置真实请求一次模型接口，返回模型的原话
- 「保存并重启」→ 写盘 + 热重启，之后正常说话即可

**配置优先级**：`runtime.json` 覆盖 `config.js`。也就是说网页面板改过的项会盖掉 `config.js` 里的值。想回到手改 `config.js` 的状态，删掉 `runtime.json` 再重启即可。

**安全说明**：默认只监听 `127.0.0.1`，仅本机可访问，接口无鉴权。API Key 在界面上是脱敏的（`sk-f8••••c224`），留空不修改，明文只存在服务器内存和 `config.js` / `runtime.json` 里。

若要在局域网内用手机打开：`set HOST=0.0.0.0 && node server.mjs` —— 但这等于把改配置的权限开放给同网段所有人，仅在可信网络下这么做。

## 五、登录失败怎么办（大概率会遇到）

报 `❌ 小米账号登录失败` = 触发了小米风控，属于正常现象，用 `passToken` 绕过：

1. Chrome 登录 <https://account.xiaomi.com>
2. F12 → **Application / 应用** → Cookies → 找到 `passToken`，复制值
3. 在 `config.js` 的 `speaker` 里加一行：

```js
passToken: "刚才复制的值",
```

`passToken` 等同于账号密码，别外传。登录成功后凭据会缓存到本目录的 `.mi.json`，也一并保管好。

## 六、网易云音乐点播

说「**播放晴天**」「**放首歌**」「**来一首告白气球**」时，控制台会自动从网易云搜歌，把音频流直接推给音箱，不再走小爱原生点播。

### 两种模式

| 模式 | 怎么进 | 能听到什么 |
| --- | --- | --- |
| 游客（默认） | 不用做任何事 | 游客曲库，主流歌多为翻唱/现场版；正版返回 `url: null` |
| 登录 | 控制台粘贴 `MUSIC_U` cookie | 完整正版曲库；VIP 歌曲还需账号有会员 |

登录方法：浏览器登录 music.163.com → F12 → Application → Cookies → 复制 `MUSIC_U` 的值 → 控制台「网易云音源」栏粘贴 → 登录网易云。cookie 存在 `netease.json`（已进 `.gitignore`，等同账号凭据）。

网易云的**扫码登录接口已被官方下线**（`/api/login/qrcode/unikey/qr/check` 实测 404），所以只能粘贴 cookie。`MUSIC_U` 长期有效，不用频繁换。

### 只挑正版（登录后默认开启）

登录后点歌只从**官方发行版本**里挑：先按「原唱封面标记 `originCoverType`、歌名/歌手关键词（翻唱/DJ/Live/伴奏/史诗版等）、专辑发行公司」把搜索结果分成正版和翻唱，优先播正版的最高音质。搜不到正版时**不再播翻唱**，而是自动交给小爱原生（音箱自己搜，通常能找到其他音源），并在卡片上提示「这首歌可能不在网易云曲库」。

- 控制台音乐卡片上，翻唱会标注 **（翻唱版）**
- 想改这个行为：`config.js` → `music.allowCover`（`null` = 自动：登录拒翻唱、游客收翻唱；`true` = 强制允许；`false` = 强制拒绝）
- **周杰伦的歌不是会员问题**：他的曲库 2018 年起就在网易云整体下架了，搜「晴天」「七里香」出来的全是翻唱号，登录/开会员也没用，所以这些歌会走小爱原生

### 触发词规则

```
播放晴天        → 点播「晴天」
放首歌 / 播放音乐 → 随机一首（从 music.playlistId 歌单挑可播的）
来一首告白气球    → 点播
我想听周杰伦的歌  → 点播「周杰伦」
暂停 / 下一首     → 不拦截，小爱原生控制当前媒体
```

指令解析在 `boot.mjs` 的 `parseMusicCommand`：`MUSIC_CTRL` 是播放控制白名单（优先级最高，交给小爱），`MUSIC_PLAY` 是点播正则。网易云没找到可播版本时会自动退回小爱原生搜歌，不会卡死。

### 控制台能做什么

- 对话流新增 **🎵 红色音乐卡片**：歌名、歌手、来源模式（游客/登录）、翻唱标记、耗时
- 「网易云音源」栏：登录状态（已登录 · 昵称 · VIP 等级）、粘贴 cookie、**▶ 随机放一首**（不需要对音箱说话，直接点）
- 运行日志能看到 `🎵 网易云点播` 和版权失败原因

### 实现要点

- 音频流通过 MiNA `play({url})` 下发，播前会先 `stop()` 打断当前播放
- 直链来自 `api/song/enhance/player/url`，游客最高 320kbps
- 随机模式批量试探歌单里最多 100 首的直链，只挑有 URL 的随机播——所以不会撞到"点了一首没版权的歌"
- 配置在 `config.js` 的 `music` 段：`enabled`（总开关）、`playlistId`（随机歌单，默认热歌榜 3778678）、`br`（音质）、`allowCover`（是否允许翻唱，`null` 自动）



## 六·五、xiaomusic 音源（当前启用）

> **当前 `config.js` → `music.source: "xiaomusic"`**，网易云音源代码保留但未启用，改回 `"netease"` 即切换。

音箱点播现在走 [hanxi/xiaomusic](https://github.com/hanxi/xiaomusic) v0.6.1：它用 yt-dlp 从 **B 站搜索下载歌曲到本地曲库**，再推给音箱播放。曲库越用越大，第二次点同一首歌**秒播**，不依赖任何音乐平台的版权和 cookie。

### 启动方式

```bat
rem 双击运行（推荐，已固化 PATH 修复）
xiaomusic\start.bat
```

或手动：

```bash
cd xiaomusic
export PATH="/c/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/Scripts:$PATH"
python -m xiaomusic.cli --config config.json
```

**PATH 前置是必须的**：下载依赖 yt-dlp，必须用 WorkBuddy 内置 Python（3.13.12）的 yt-dlp；不前置 PATH 会被 system32 老版本抢占，B 站下载 412 报错。

服务跑在 `http://127.0.0.1:8090`（管理界面 / 曲库管理都在这）。本地曲库在 `xiaomusic\music\download\`。

### 语音口令怎么处理

| 口令 | 谁来处理 |
| --- | --- |
| 「播放晴天」「放首歌」「来一首稻香」 | **xiaomusic**（MiGPT 控制台静默放行，`boot.mjs` 里 `wrapOnMessage` 对点播口令返回 `handled:true`，不搜网易云、不走大模型；实际播放靠 xiaomusic 自己的 `enable_pull_ask` 1 秒轮询） |
| 「暂停」「下一首」「音量调到 50」 | 小爱原生 + xiaomusic 双方各自处理（`MUSIC_CTRL` 不拦截） |

### 控制台 xiaomusic 卡片

控制台新增「xiaomusic 音源」栏（网易云栏之后），5 秒轮询 `GET /api/xiaomusic` 聚合状态：在线/版本、当前播放（歌名 + 进度条 `♪ 歌名 · 1:23/5:26`）、音量、曲库歌曲数。按钮：

- **搜索并播放**：`POST /api/xiaomusic/play {keyword}`（走 xiaomusic `/playmusic`，曲库没有会先下载——**该接口阻塞到下载+开播结束，最长 180s**，新歌第一次点要等）
- **下一首 / 停止**：`/cmd` 和 `/device/stop`
- **刷新曲库**：`POST /api/music/refreshlist`（往 `music/download` 手动放了文件后点这个）

### 三个大坑（都是实测踩出来的）

1. **bilisearch 固定输出名报错**：`Fixed output name but more than one file to download`。bilisearch 在 CLI 层把搜索展开成多个 URL，固定 `-o` 文件名触发 yt-dlp 的多文件检查。`--playlist-items 1` **无效**（那是播放列表条目选择）；有效的是 `--max-downloads 1`。补丁位置：`device_player.py` 的 `download()` 函数，搜 `PATCH(2026-10-31)`。
2. **yt-dlp 全局配置必须加引号**：`%APPDATA%\yt-dlp\config` 里含空格的值（如 User-Agent）必须加英文引号，否则被 shlex 拆碎，每个单词被当 URL（`'XXX' is not a valid URL` 非致命错误）——这正是 xiaomusic 子进程**间歇性 412** 的根因。当前配置已修好：UA + `--referer https://www.bilibili.com/`。
3. **TTS 下载竞态杀歌**：xiaomusic 下载前播 TTS「正在下载歌曲X」，并设了 `时长+2` 秒的定时器强制 stop。下载快于 ~4.5s 时音乐先开播、stop 再把歌杀掉。补丁：`device_player.py` 记录 `_last_group_play_at`，`_tts_timeout` 回调发现 TTS 之后有新开播就跳过 stop（搜 `PATCH(2026-10-31)`）。

> ⚠️ **这三处补丁直接改在 pip 安装的 xiaomusic 源码里**（`%PYDIR%\Lib\site-packages\xiaomusic\device_player.py`）。pip 重装/升级 xiaomusic 会丢失补丁，需按 `PATCH(2026-10-31)` 注释重新应用。

### xiaomusic API 备查（v0.6.1）

`POST /cmd {did,cmd}`、`POST /playmusic {did,musicname,searchkey}`（阻塞）、`POST /device/stop {did}`、`POST /setvolume`、`GET /playingmusic?did=`（`{is_playing, cur_music, offset, duration}`）、`GET /musiclist`、`GET /device_list`（did 取 `miotDID`）、`POST /api/music/refreshlist`。控制台封装在 `server.mjs` 的 `xmStatus()/xmAction()`。

### 网易云歌单已接入 xiaomusic（网络歌单）

`music_list_url` = `http://127.0.0.1:3000/xiaomusic-playlist.json`（issue #78 格式），账号「天使红魔鬼」的全部 10 个歌单 / 704 首 + **周杰伦全部 47 张专辑（443 首去重）**已进 xiaomusic 曲库，语音说「**播放歌单 陈奕迅**」「**播放歌单 周杰伦七里香**」「播放列表」即可播放。

- **直链机制**：网易云 CDN 直链会过期且需要 cookie，所以歌单里每首歌的 url 指向控制台 `GET /netease-stream/<歌曲ID>?name=<歌名-歌手>`——播放时实时解析 320k 直链并 302 重定向，xiaomusic 的代理（`web_music_proxy: true`）负责把流量转给音箱
- **灰名单 B 站兜底**：周杰伦等版权独家歌在网易云全部解析失败（code 404，QQ 音乐独家）。带 `name` 参数时服务端自动 fallback：用内置 yt-dlp 执行 `bilisearch1:<歌名-歌手> -f bestaudio -g` 搜 B 站第一个结果解析音频直链 302（约 2 秒），结果缓存 30 分钟。QQ 音乐官方链路不可行（游客拿不到 vkey，meting/sayqz 等公共直链 API 均已失效）
- **周杰伦专辑歌单**：`gen-netease-playlist.mjs` 会自动追加（artist 6452，`/api/artist/albums/6452` 拿 `hotAlbums`，`/api/v1/album/<id>` 拿曲目）：≥5 首的专辑单独成歌单（名如「周杰伦七里香」「周杰伦最伟大的作品」），1-2 首单曲并入合集「**周杰伦全部专辑**」（443 首去重）
- **歌单更新**：网易云收藏了新歌后跑 `node gen-netease-playlist.mjs` 重新生成 JSON，再 `POST /cmd {did, cmd:"刷新列表"}`（或等 crontab 触发「刷新网络歌单」）
- **播放歌单 API**：`POST /playmusiclist {did, listname, musicname}`——⚠️ 必须传 `listname`（歌单名），只传 `musicname` 会随机播「所有歌曲」；`musicname` 可留空或传指定曲目名
- **注意**：B 站搜不到的歌（极少数）兜底失败返回 404 跳过；VIP 歌需要 cookie 账号有会员（当前账号 V5 音乐包到 2027，OK）





## 七、怎么验证改造成功

1. 控制台出现登录成功的设备信息；
2. 对音箱说 **「小爱同学，请问你是谁」**（句首的「请」命中 `callAIKeywords`）；
3. 小爱原生回答会**说到一半被打断**，紧接着念出大模型生成的回答；
4. 说「小爱同学，现在几点」「小爱同学，音量 30」，这类指令由**小爱原生**处理，MiGPT 不插手（避免答两遍）。

实测日志（成功时应有这四行）：

```
🔥 你现在是什么模型
   ↳ 打断原生播报：已发送 stop
🔊 我是 DeepSeek 最新版本的模型，由深度求索公司开发…
   ↳ 播报指令返回：true  耗时 513ms
```

### 为什么"我说了它不理我"——触发规则是句首匹配

源码里只有一行判断（`@mi-gpt/engine/dist/index.js:58`）：

```js
this.config.callAIKeywords?.some((k) => msg.text.startsWith(k))
```

是 **`startsWith`，前缀匹配，不是包含**。所以：

| 说法 | 结果 | 原因 |
| --- | --- | --- |
| 请问你是谁 | ✅ 走大模型 | 第一个字是「请」 |
| 你叫什么名字 | ✅ 走大模型 | 第一个字是「你」 |
| 帮我算一下 | ✅ 走大模型 | 「帮」在词表里 |
| **我想**请问一下 | ❌ 走小爱原生 | 第一个字是「我」，词表里没有 |
| **今天**天气怎么样 | ✅ 走大模型（已补「今天」） | |
| 放首歌 / 现在几点 / 音量 40 | ❌ 走小爱原生 | **故意的**，原生做得更好 |

`config.js` 默认词表有 33 个词，覆盖常见问句开头。**不想挑词就开「全部接管」**：右侧面板勾选该选项（等价于 `callAIKeywords: [""]`，空串 `startsWith` 恒为 true），说什么都会交给大模型。

全接管模式下有原生保护（`boot.mjs` 的 `NATIVE_PATTERNS`）：音量、播放控制、闹钟、开关灯、报时、音乐类会让路给小爱，不会被 AI 抢走。新增保护就改这个正则数组。

#### 「全部接管」怎么开关

位置：右侧配置面板 → **触发方式** 那一栏的复选框。

| 操作 | 内部发生什么 | 结果 |
| --- | --- | --- |
| 勾选 → 保存并重启 | `runtime.json` 写入 `callAIKeywords: [""]` | 说什么都走大模型 |
| 取消勾选 → 保存并重启 | 输入框自动回填出厂 33 词，写入 `runtime.json` | 退回句首关键词模式 |
| 取消勾选但把词表删空 → 保存 | 后端自动补回出厂 33 词 | 同样退回原状态，不会变成"全不触发" |

两个实现细节（改代码时别踩）：

1. **空串 `""` 是「全部接管」的开关**。`"任何话".startsWith("")` 恒为 `true`，所以 `callAIKeywords: [""]` 等于接管一切。界面上用 `"*"` 表示，`server.mjs` 负责 `["*"] ⇄ [""]` 双向翻译。
2. **取消勾选必须显式写词表**。如果只把 `runtime.json` 里的 `[""]` 删掉而什么都不写，文件里残留的 `[""]` 会继续生效 —— 表现就是"取消了全接管，重启后还是全接管"。`buildPatch` 里对空词表补 `BASE_KEYWORDS` 就是为了堵这个。

> 关于本地指令：早期版本 `config.js` 里用 `onMessage` 接管了「现在几点」「音量」，实测会和原生回答同时播报，出现**答两遍**。原因在 `@mi-gpt/engine` 源码：`onMessage` 的回调在 `callAIKeywords` 判断**之前**执行，返回值非空就立即播报。想加自定义指令时，务必用专属前缀（如「助手」开头）限定，别拦截原生能处理的指令。

### 为什么你的机器能打断小爱（核心改造，别删）

`@mi-gpt/next` 里 `speaker.abortXiaoAI()` 是**空实现**：

```js
// node_modules/@mi-gpt/next/dist/chunk-GUYKBNC6.js:25
async abortXiaoAI() {
  return false;      // 什么都没做
}
```

不补它会出现这种诡异现象：日志明明打了 `🔊 回答内容`，播报指令也返回 `true`，但音箱只有小爱自己的声音。原因是小爱原生回答早已播完，AI 的回答在对话结束时被静默丢弃。

`index.mjs` 里用 `mediaplayer` 的 `stop` 指令补上了这个能力：

```js
MiGPT.speaker.abortXiaoAI = async () => {
  const ok = await MiGPT.MiNA?.stop();   // 真正打断原生播报
  return ok;
};
```

同时包装了 `speaker.play`，把返回值与耗时打印出来——引擎原本只打印文本就调用 `play`，失败时异常被吞掉，根本看不出是真播了还是被拒。

**结论**：HTTP API 这条路在 OH2P 上**能打断原生回答**，不需要刷机。这是对项目默认行为的关键补强。

## 八、OH2P 这类新固件的已知限制（别抱错期待）

| 现象 | 原因 | 能不能解 |
| --- | --- | --- |
| 小爱抢话，AI 回答被打断 | `abortXiaoAI()` 是空实现 | ✅ **已解**，见上文「核心改造」，用 `MiNA.stop()` 补上 |
| 响应有 2~4 秒延迟 | 轮询 MiNA 消息队列，天然有延迟 | 无法优化到实时；`heartbeat` 调小可减轻 |
| 连续对话不可用 | migpt-next 已主动移除 streamResponse | 项目方决定，非配置问题 |
| 偶尔 TTS 不发声 | 设备状态查询失败导致中断 | 重说一次即可 |
| 说什么都回「抱歉，语音服务遇到问题」 | **与 MiGPT 无关**，是音箱 ASR 通道卡住 | 拔电源 10 秒重插，等开机提示音播完 |

### 「抱歉，语音服务遇到问题」怎么判断不是改造的锅

三个信号同时成立就与 MiGPT 无关：

1. 控制台**没有** `🔥 文本` 输出 —— 引擎对每条收到的消息都会打印这一行，没有就是真没收到；
2. 云端会话记录里**没有**这次说话 —— 跑 `node debug-conv.mjs` 看最新时间戳；
3. 紧接着测云端 ubus 却正常（`getStatus()` 返回 `idle`）—— 长连接在线，但音频上传是另一条通道。

根源是 ASR 阶段就失败了，压根没生成会话记录，MiGPT 轮询不到自然完全无感。断电重启最有效。

## 九、项目状态（必须知道）

`migpt-next`、`mi-gpt`、`open-xiaoai` **三个仓库都已是 Public archive（停止维护）**，
作者已不提供更新和支持。当前版本装得上、能用，但小米改接口就没人修了。
如果哪天彻底失效，唯一出路是刷机方案 `open-xiaoai`——OH2P 是新款超级小爱机型，
刷机适配情况需自行到该项目 issue 区确认，别直接动手。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `config.js` | 基础配置：账号、模型、人设（手改这里永久生效） |
| `runtime.json` | 网页面板保存的覆盖配置，优先级高于 `config.js`；删掉即回到手改模式 |
| `boot.mjs` | 启动核心：配置合并、补丁（打断 + 播报日志）、事件总线、热重启 |
| `server.mjs` | Web 控制台后端：SSE 实时推送、配置 API、模型连通性测试、网易云登录 API |
| `netease.mjs` | 网易云接入：搜索、批量拿直链、找可播版本、随机歌单、cookie 管理 |
| `public/index.html` | 控制台界面（单文件，无外部依赖） |
| `index.mjs` | 纯命令行入口，不带界面（`npm run cli`） |
| `check.mjs` | 上线前自检：配置→大模型接口→小米登录→设备名匹配（`SKIP_MI=1` 可跳过小米那步） |
| `test-speaker.mjs` | 真机出声测试：设音量 + 播放一句 TTS，验证云端 ubus 链路 |
| `devices.mjs` | 列出账号下的小爱设备，用于确认 `did` |
| `debug-conv.mjs` | 拉取音箱最近对话记录（带时间线与「会不会被 MiGPT 处理」标记） |
| `abort-test.mjs` | 隔离实验：验证「正在播报时插入新指令」是否被丢弃 |
| `start.bat` | Windows 一键启动控制台并打开浏览器 |
| `.mi.json` | 登录后自动生成，含 serviceToken，别提交/外传 |
| `netease.json` | 网易云 cookie（粘贴 MUSIC_U 后生成），等同账号凭据，别提交/外传 |

## 免责

第三方非官方项目，与小米无隶属关系；仅限个人自用，账号风控风险自担。建议不要用主账号密码，可以单独建一个小米账号把音箱绑过去再改。
