/**
 * 小米音箱改造配置 —— 设备：Xiaomi 智能音箱 Pro (MiAiSoundbox-OH2P)
 *
 * 官方兼容表里 OH2P 属于「✅ 完美运行」档：
 *   ttsCommand    [7, 3]
 *   wakeUpCommand [7, 1]
 *   反馈来源      @idootop（项目作者本人用这台机器测试）
 *
 * ⚠️ 三个必填项（把下面 xxx 替换掉）：
 *   speaker.userId   → 小米 ID（纯数字，不是手机号/邮箱）
 *   speaker.password → 小米账号密码
 *   openai.apiKey    → 大模型 API Key
 */

export default {
  speaker: {
    userId: process.env.MI_USER ?? "",       // 小米 ID：account.xiaomi.com → 个人信息 → 小米 ID
    password: process.env.MI_PASS ?? "",  // 小米账号密码
    did: process.env.MI_DID_NAME ?? "Xiaomi 智能音箱 Pro", // 米家 App 里音箱显示名，必须完全一致

    // 如果启动时报「小米账号登录失败」（触发了风控），取消下面这行注释并填入 passToken
    // 2026-10-30 从 Edge 的 account.xiaomi.com Cookie 中提取
    passToken: process.env.MI_PASS_TOKEN ?? "",

    // 轮询云端消息的间隔（毫秒）。
    // 这是延迟的最大头：设 3000 就是最多等 3 秒才发现你说了话。
    // 项目源码里 Math.max(1000, heartbeat) 限制了最低 1000，再小也无效。
    heartbeat: 1000,

    // OH2P 的指令编号，正常情况下由内置适配自动识别，无需改动；
    // 若出现「有文字但音箱不发声」，把它打开即可强制走这台机型的 TTS 指令
    // ttsCommand: [7, 3],
    // wakeUpCommand: [7, 1],
  },

  openai: {
    model: "deepseek-flash",                          // 换成你要用的模型
    baseURL: "https://api.deepseek.com",           // 兼容 OpenAI 协议即可，结尾不要带 /
    apiKey: process.env.OPENAI_API_KEY ?? "",
  },

  prompt: {
    system:
      "你是一个中文语音助手，回答会被直接朗读出来。请用口语化、简短自然的中文回答，" +
      "控制在两三句话以内，不要使用列表、Markdown、表情符号和括号注释。",
  },

  /**
   * 音乐点播音源。
   *
   * source: "xiaomusic"（推荐，默认使用）
   *   说「播放晴天」「放首歌」交给 xiaomusic（http://127.0.0.1:8090）处理：
   *   它通过 yt-dlp 从 B 站搜索下载歌曲到本地曲库后推给音箱播放，全曲库免费。
   *   MiGPT 只拦截口令保持静默，下载/播放全部由 xiaomusic 的语音轮询完成。
   *
   * source: "netease"
   *   走网易云搜索 + MiNA 音频流下发。音箱无法访问会员加密流，
   *   登录模式（粘贴 MUSIC_U cookie）为完整正版曲库；游客模式多为翻唱。
   */
  music: {
    enabled: true,
    // 音源：xiaomusic（本地下载方案）或 netease（网易云直连方案）
    source: "xiaomusic",
    // xiaomusic 服务地址（xiaomusic/config.json 里的 hostname:port）
    xiaomusicUrl: process.env.XIAOMUSIC_URL ?? "http://127.0.0.1:8090",

    // ── 以下仅 netease 音源生效 ──
    // 随机模式（「放首歌」这种没说歌名的）从哪个歌单挑：3778678 = 云音乐热歌榜
    playlistId: "3778678",
    // 音质：128000 / 192000 / 320000。游客最高能拿到 320000
    br: 320000,
    // 是否接受翻唱/改编版本。null = 自动：登录后不接受（翻唱难听，宁可让小爱原生放），
    // 游客模式接受（游客本来就只能翻唱）。设 true / false 可强制覆盖。
    // 注意：周杰伦的歌 2018 年起不在网易云曲库，任何账号都拿不到正版，登录也没用。
    allowCover: null,
  },

  /**
   * 触发大模型的「句首关键词」。
   *
   * ⚠️ 引擎的判定是 msg.text.startsWith(k)，是**前缀匹配，不是包含**：
   *      ✅「请问你是谁」「你叫什么」「今天怎么样」→ 命中（看第一个字）
   *      ❌「我想请问一下」「帮我看看今天」→ 不命中（第一个字是「我」）
   *    所以词表里必须覆盖「话的开头」，把词加在中间毫无意义。
   *
   * 想让说什么都走大模型：把数组改成 [""]，或在 Web 控制台勾选「全部接管」。
   * 空字符串 startsWith 恒为 true，引擎会接管每一句话。
   *
   * 刻意不收录的开头（会把原生功能抢走）：
   *   我 / 放 / 来 / 打开 —— 「我想听歌」「来首歌」会被转给大模型，音乐就放不出来了。
   */
  callAIKeywords: [
    "请", "你", "帮", "讲", "说", "介绍", "解释", "告诉", "翻译",
    "为什么", "怎么", "怎样", "如何", "什么", "啥", "谁", "哪", "多少",
    "能不能", "可不可以", "有没有", "是不是", "会不会",
    "今天", "明天", "写", "算", "聊", "用",
    "评价", "分析", "推荐", "对比",
  ],

  /**
   * 自定义回复：执行顺序在 callAIKeywords 判断之前，返回值非空就立即播报。
   * 返回 { text } 播报文字；返回 { url } 播报音频；返回 { handled: true } 表示已自行处理。
   *
   * ⚠️ 注意：这里不要拦截小爱原生就能处理的指令（时间、音量、天气等），
   * 否则会和原生回答同时播报，出现「答两遍」。
   */
  async onMessage(engine, { text }) {
    // 示例：只在特定前缀下接管，避免与原生指令冲突
    // if (text.startsWith("助手")) {
    //   return { text: "我在听" };
    // }

    // 其余交给默认流程（命中 callAIKeywords 才走大模型，否则小爱原生处理）
  },
};
