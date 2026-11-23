/**
 * 小爱音箱 · 本地控制台
 *
 *   node server.mjs        → http://127.0.0.1:3000
 *   PORT=8080 node server.mjs
 *   HOST=0.0.0.0 node server.mjs   ⚠️ 局域网可访问，无鉴权，仅在可信网络下使用
 *
 * 功能：实时对话流（SSE）、在线改模型配置、热重启。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, BASE_KEYWORDS, boot, onEvent, getHistory, getStatus, readRuntime, writeRuntime, effectiveConfig, restart, playFromNetease, getEngine } from "./boot.mjs";
import { readNetease, writeNetease, clearNetease, whoAmI } from "./netease.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_DIR = path.join(ROOT, "public");
// 网易云灰名单歌（如周杰伦版权曲）兜底：用 yt-dlp 从 B 站解析音频直链
// 本地默认 WorkBuddy 内置路径；云服务器设 YTDLP_BIN=yt-dlp（PATH 中）即可
const YTDLP = process.env.YTDLP_BIN ?? "C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/Scripts/yt-dlp.exe";

/* ══════════════════════ 工具 ══════════════════════ */

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 256 * 1024) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

/** 当前配置快照（Key 脱敏，绝不回传明文） */
function snapshot() {
  const cfg = effectiveConfig();
  // 引擎里 [""] 表示「全部接管」（空串 startsWith 恒为 true），
  // 但直接回传会让界面输入框变成空值，这里翻译成 "*" 让用户看得懂
  const kw = cfg.callAIKeywords ?? [];
  const keywordsForUI = kw.length === 1 && kw[0] === "" ? ["*"] : kw;

  return {
    config: {
      model: cfg.openai?.model ?? "",
      baseURL: cfg.openai?.baseURL ?? "",
      apiKeyMasked: maskKey(cfg.openai?.apiKey),
      hasApiKey: Boolean(cfg.openai?.apiKey),
      systemPrompt: cfg.prompt?.system ?? "",
      callAIKeywords: keywordsForUI,
      catchAll: keywordsForUI[0] === "*",
      // 出厂词表，前端取消勾选时用来回填，保证能退回原状态
      defaultKeywords: BASE_KEYWORDS,
      heartbeat: cfg.speaker?.heartbeat ?? 1000,
      userId: cfg.speaker?.userId ?? "",
      did: cfg.speaker?.did ?? "",
    },
    status: getStatus(),
    hasOverride: Object.keys(readRuntime()).length > 0,
  };
}

/* ══════════════════════ 静态文件 ══════════════════════ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "禁止访问" });

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

/* ══════════════════════ SSE ══════════════════════ */

const clients = new Set();

function sseHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 2000\n\n`);

  // 补发历史，刷新页面不丢上下文
  for (const e of getHistory(200)) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: "status", time: Date.now(), ...getStatus() })}\n\n`);

  clients.add(res);

  const ping = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/* ══════════════════════ 业务接口 ══════════════════════ */

/** 只接受白名单字段，避免往 runtime.json 写入任意内容 */
function buildPatch(body) {
  const patch = { openai: {}, prompt: {}, speaker: {} };

  if (typeof body.model === "string" && body.model.trim()) {
    patch.openai.model = body.model.trim();
  }
  if (typeof body.baseURL === "string" && body.baseURL.trim()) {
    patch.openai.baseURL = body.baseURL.trim().replace(/\/+$/, "");
  }
  // 空字符串或含占位符 = 用户没改 Key，保持原值
  if (typeof body.apiKey === "string" && body.apiKey.trim() && !body.apiKey.includes("••")) {
    patch.openai.apiKey = body.apiKey.trim();
  }
  if (typeof body.systemPrompt === "string" && body.systemPrompt.trim()) {
    patch.prompt.system = body.systemPrompt.trim();
  }
  if (Array.isArray(body.callAIKeywords)) {
    const list = body.callAIKeywords.map((s) => String(s).trim());
    if (list.includes("*")) {
      // 全部接管：落库成 [""]，空串 startsWith 对任何文本都为 true
      patch.callAIKeywords = [""];
    } else {
      const kw = list.filter(Boolean);
      // 空词表（取消勾选但没填词）= 退回 config.js 出厂词表。
      // ⚠️ 这里必须显式写入，否则 runtime.json 里残留的 [""] 会继续生效，
      //    表现就是「取消了全接管，重启后还是全接管」。
      patch.callAIKeywords = kw.length ? kw : BASE_KEYWORDS;
    }
  }
  if (Number.isFinite(Number(body.heartbeat))) {
    patch.speaker.heartbeat = Math.max(1000, Math.min(60000, Number(body.heartbeat)));
  }

  // 清掉空对象，避免 runtime.json 里堆 {} 
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === "object" && Object.keys(patch[k]).length === 0) delete patch[k];
  }
  return patch;
}

async function handleApi(req, res, urlPath) {
  if (req.method === "GET" && urlPath === "/api/state") {
    return json(res, 200, snapshot());
  }

  if (req.method === "GET" && urlPath === "/api/history") {
    return json(res, 200, { events: getHistory(200) });
  }

  if (req.method === "POST" && urlPath === "/api/config") {
    const body = await readBody(req);
    const patch = buildPatch(body);
    writeRuntime(patch);
    broadcast({ type: "log", time: Date.now(), level: "log", text: "💾 配置已保存到 runtime.json" });
    return json(res, 200, { ok: true, state: snapshot() });
  }

  if (req.method === "POST" && urlPath === "/api/restart") {
    json(res, 200, { ok: true });
    // 后台执行，避免阻塞响应
    restart().catch((e) => {
      broadcast({ type: "log", time: Date.now(), level: "error", text: `重启失败：${e?.message ?? e}` });
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/api/test-model") {
    // 保存前先验证模型接口是否可用，避免配错了自己不知道
    const body = await readBody(req);
    const cfg = effectiveConfig();
    const baseURL = (body.baseURL || cfg.openai?.baseURL || "").replace(/\/+$/, "");
    const apiKey = body.apiKey && !String(body.apiKey).includes("••") ? body.apiKey.trim() : cfg.openai?.apiKey;
    const model = body.model || cfg.openai?.model;

    if (!baseURL || !apiKey || !model) {
      return json(res, 400, { ok: false, error: "模型、Base URL、API Key 任一项缺失" });
    }

    try {
      const r = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "回复两个字：正常" }],
          max_tokens: 512,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text();
      let content = "";
      try {
        content = JSON.parse(text)?.choices?.[0]?.message?.content?.trim() ?? "";
      } catch {
        /* 非 JSON 响应，下面统一处理 */
      }
      if (!r.ok) {
        return json(res, 200, { ok: false, status: r.status, error: text.slice(0, 300) });
      }
      return json(res, 200, { ok: Boolean(content), status: r.status, content: content || "(响应为空)" });
    } catch (e) {
      return json(res, 200, { ok: false, error: e?.message ?? String(e) });
    }
  }

  if (req.method === "POST" && urlPath === "/api/say") {
    // 让音箱直接念一句，用于验证「云端 ubus → 音箱出声」这条链路
    const body = await readBody(req);
    const text = String(body.text ?? "").trim() || "控制台连接正常";
    const engine = getEngine();
    if (!engine?.MiNA) {
      return json(res, 503, { ok: false, error: "引擎尚未就绪，稍等几秒再试" });
    }
    try {
      const ok = await engine.MiNA.play({ text });
      return json(res, 200, { ok: Boolean(ok), text });
    } catch (e) {
      return json(res, 200, { ok: false, error: e?.message ?? String(e) });
    }
  }

  if (req.method === "GET" && urlPath === "/api/netease") {
    const ne = readNetease();
    let vipType = 0;
    if (ne.cookie) {
      const me = await whoAmI(ne.cookie).catch(() => null);
      vipType = me?.vipType ?? 0;
    }
    return json(res, 200, { hasCookie: Boolean(ne.cookie), nickname: ne.nickname, vipType });
  }

  if (req.method === "POST" && urlPath === "/api/netease/cookie") {
    // 粘贴 MUSIC_U cookie 即登录：先验证再保存，坏 cookie 不落盘
    const body = await readBody(req);
    const cookie = String(body.cookie ?? "").trim().replace(/^Cookie:\s*/i, "");
    if (!cookie) return json(res, 400, { ok: false, error: "cookie 不能为空" });
    try {
      const profile = await whoAmI(cookie);
      if (!profile) {
        return json(res, 200, { ok: false, error: "cookie 无效（网易云不认），重新复制完整的 MUSIC_U 值" });
      }
      writeNetease({ cookie, nickname: profile.nickname });
      broadcast({ type: "log", time: Date.now(), level: "log", text: `🎵 网易云已登录：${profile.nickname}` });
      return json(res, 200, { ok: true, nickname: profile.nickname });
    } catch (e) {
      return json(res, 200, { ok: false, error: `验证失败：${e?.message ?? e}` });
    }
  }

  if (req.method === "POST" && urlPath === "/api/netease/logout") {
    clearNetease();
    broadcast({ type: "log", time: Date.now(), level: "log", text: "🎵 网易云已退出登录（回到游客模式）" });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && urlPath === "/api/music") {
    // 网易云点播：keyword 空 = 从歌单随机；等价于对音箱说「播放xxx」
    const body = await readBody(req);
    const keyword = String(body.keyword ?? "").trim();
    const engine = getEngine();
    if (!engine?.MiNA) {
      return json(res, 503, { ok: false, error: "引擎尚未就绪，稍等几秒再试" });
    }
    const cfg = effectiveConfig();
    if (cfg.music?.enabled === false) {
      return json(res, 200, { ok: false, error: "音乐点播已在配置中关闭" });
    }
    const r = await playFromNetease(engine, keyword);
    // r = {handled:true} 表示已下发；undefined 表示没找到可播的（日志里有原因）
    return json(res, 200, { ok: r !== undefined, keyword });
  }

  /* ──────────────── xiaomusic 音源 ──────────────── */

  if (req.method === "GET" && urlPath === "/api/xiaomusic") {
    return json(res, 200, await xmStatus());
  }

  if (req.method === "POST" && urlPath.startsWith("/api/xiaomusic/")) {
    const body = await readBody(req);
    const action = urlPath.slice("/api/xiaomusic/".length);
    const r = await xmAction(action, body);
    return json(res, r?.httpStatus ?? 200, r?.body ?? { ok: false, error: "未知操作" });
  }

  return json(res, 404, { error: "接口不存在" });
}

/* ══════════════════════ xiaomusic 代理 ══════════════════════ */

/** xiaomusic 服务地址（config.music.xiaomusicUrl） */
function xmBase() {
  return String(effectiveConfig().music?.xiaomusicUrl ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
}

async function xmFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(opts.timeout ?? 8000),
  });
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: null, text: text.slice(0, 200) };
  }
}

let xmDidCache = { did: null, name: null, at: 0 };

/** 解析目标音箱 did：优先用配置里 speaker.did 匹配设备名，否则取第一台在线设备 */
async function xmResolveDid() {
  if (Date.now() - xmDidCache.at < 5 * 60_000 && xmDidCache.did) return xmDidCache;
  const { data } = await xmFetch(`${xmBase()}/device_list`);
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  if (!devices.length) throw new Error("xiaomusic 没有发现任何设备");
  const wantName = effectiveConfig().speaker?.did ?? "";
  const dev =
    devices.find((d) => d.name === wantName || d.alias === wantName) ??
    devices.find((d) => d.presence === "online") ??
    devices[0];
  xmDidCache = { did: String(dev.miotDID), name: dev.alias || dev.name, at: Date.now() };
  return xmDidCache;
}

/** 聚合状态：版本 / 设备 / 正在播放 / 音量 / 曲库数量 */
async function xmStatus() {
  const base = xmBase();
  try {
    const [{ data: ver }, didInfo] = await Promise.all([
      xmFetch(`${base}/getversion`),
      xmResolveDid(),
    ]);
    const did = didInfo.did;
    const [{ data: playing }, { data: vol }, { data: list }] = await Promise.all([
      xmFetch(`${base}/playingmusic?did=${did}`),
      xmFetch(`${base}/getvolume?did=${did}`),
      xmFetch(`${base}/musiclist`),
    ]);
    const songCount = Object.values(list ?? {})
      .reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    return {
      online: true,
      version: ver?.version ?? null,
      did,
      didName: didInfo.name,
      isPlaying: playing?.is_playing === true,
      curMusic: playing?.cur_music ?? "",
      offset: playing?.offset ?? 0,
      duration: playing?.duration ?? 0,
      volume: vol?.volume ?? null,
      songCount,
    };
  } catch (e) {
    return { online: false, error: e?.message ?? String(e) };
  }
}

/** 控制操作：play=点播下载播放，cmd=语音命令（下一首/暂停…），stop=停止 */
async function xmAction(action, body) {
  const base = xmBase();
  let did;
  try {
    did = (await xmResolveDid()).did;
  } catch (e) {
    return { body: { ok: false, error: e?.message ?? String(e) } };
  }
  const log = (level, text) =>
    broadcast({ type: "log", time: Date.now(), level, text });

  try {
    if (action === "play") {
      const keyword = String(body.keyword ?? "").trim();
      if (!keyword) return { body: { ok: false, error: "歌名不能为空" } };
      log("log", `🎵 xiaomusic 点播：${keyword}`);
      // 注意：xiaomusic 的 /playmusic 会阻塞到「下载+开播」流程结束（新歌首次下载可能要 1-2 分钟），
      // 所以这里给足超时
      const r = await xmFetch(`${base}/playmusic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did, musicname: keyword, searchkey: keyword }),
        timeout: 180000,
      });
      // 未下载过的歌会先走 yt-dlp 下载，耗时较长，cmdstatus 可查进度
      const ok = r.status === 200 && (!r.data || r.data.ret === "OK");
      log(ok ? "log" : "error", ok ? `🎵 已下发点播请求：${keyword}（首次播放需先下载）` : `🎵 xiaomusic 返回异常：${JSON.stringify(r.data ?? r.text)}`);
      return { body: { ok, data: r.data } };
    }

    if (action === "cmd") {
      const cmd = String(body.cmd ?? "").trim();
      if (!cmd) return { body: { ok: false, error: "cmd 不能为空" } };
      const r = await xmFetch(`${base}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did, cmd }),
      });
      return { body: { ok: r.status === 200 && r.data?.ret === "OK", data: r.data } };
    }

    if (action === "stop") {
      const r = await xmFetch(`${base}/device/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did }),
      });
      return { body: { ok: r.status === 200 && r.data?.ret === "OK" } };
    }

    if (action === "volume") {
      const volume = Number(body.volume);
      if (!Number.isFinite(volume)) return { body: { ok: false, error: "volume 无效" } };
      const r = await xmFetch(`${base}/setvolume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did, volume: Math.max(0, Math.min(100, Math.round(volume))) }),
      });
      return { body: { ok: r.status === 200 && r.data?.ret === "OK" } };
    }

    if (action === "refreshlist") {
      const r = await xmFetch(`${base}/api/music/refreshlist`, { method: "POST" });
      return { body: { ok: r.status === 200 && r.data?.ret === "OK" } };
    }

    return { body: { ok: false, error: `未知操作：${action}` } };
  } catch (e) {
    log("error", `🎵 xiaomusic 不可达：${e?.message ?? e}`);
    return { body: { ok: false, error: e?.message ?? String(e) } };
  }
}

/* ══════════════════════ 网易云直链代理（xiaomusic 网络歌单用） ══════════════════════ */

/**
 * GET /netease-stream/:songId[?name=歌名-歌手]
 * xiaomusic 网络歌单里每首歌的 url 指向这里。播放时实时用本地 cookie
 * 调网易云接口解析 320k CDN 直链并 302 重定向——直链会过期，所以必须
 * 每次播放时现取，不能把 CDN 地址静态写进歌单 JSON。
 *
 * 灰名单兜底：网易云无版权的歌（code 404，如周杰伦版权曲在 QQ 音乐独家）
 * 带 name 参数时自动改用 yt-dlp 搜 B 站第一个结果解析音频直链 302 过去。
 */

// B 站直链缓存（有效期约 4.8h，缓存 30 分钟足够一次播放会话）
const biliCache = new Map(); // name -> { url, at }
const BILI_TTL = 30 * 60 * 1000;

async function resolveBili(name) {
  const hit = biliCache.get(name);
  if (hit && Date.now() - hit.at < BILI_TTL) return hit.url;
  const url = await new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ["bilisearch1:" + name, "-f", "bestaudio", "-g", "--no-warnings", "--proxy", ""], {
      windowsHide: true,
      timeout: 90_000,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const u = out.split("\n").map((s) => s.trim()).find(Boolean);
      if (u) resolve(u);
      else reject(new Error(`yt-dlp exit ${code}: ${(err || "no output").slice(-300)}`));
    });
  });
  biliCache.set(name, { url, at: Date.now() });
  if (biliCache.size > 200) {
    const oldest = [...biliCache.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
    biliCache.delete(oldest);
  }
  return url;
}

async function handleNeteaseStream(req, res, songId, query) {
  if (!/^\d+$/.test(songId)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad song id");
    return;
  }
  try {
    const { cookie } = readNetease();
    const r = await fetch("https://music.163.com/api/song/enhance/player/url", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie ?? "",
        Referer: "https://music.163.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      body: `ids=[${songId}]&br=320000&csrf_token=`,
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    const d = j?.data?.[0];
    if (d?.code === 200 && d?.url) {
      // 直链 CDN 支持跨机访问，xiaomusic proxy fetch 会自动跟随 302
      res.writeHead(302, { Location: d.url, "Cache-Control": "no-store" });
      res.end();
      broadcast({ type: "log", time: Date.now(), level: "log", text: `🎵 网易云直链解析：${songId} br=${d.br ?? "?"}` });
    } else {
      // 200=无版权/下架，301=VIP 无权等；带 name 时用 B 站搜索兜底
      const name = query?.get("name");
      if (name) {
        try {
          const biliUrl = await resolveBili(name);
          broadcast({ type: "log", time: Date.now(), level: "log", text: `🎵 网易云无权(code ${d?.code})，B 站兜底：${name}` });
          res.writeHead(302, { Location: biliUrl, "Cache-Control": "no-store" });
          res.end();
          return;
        } catch (e) {
          broadcast({ type: "log", time: Date.now(), level: "error", text: `🎵 B 站兜底失败：${name} ${e?.message ?? e}` });
        }
      } else {
        broadcast({ type: "log", time: Date.now(), level: "error", text: `🎵 网易云直链失败：${songId} code=${d?.code ?? "?"}` });
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`no playable url (code ${d?.code ?? "?"})`);
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`resolve failed: ${e?.message ?? e}`);
  }
}

/* ══════════════════════ 服务启动 ══════════════════════ */

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);

  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    const streamMatch = u.pathname.match(/^\/netease-stream\/(\d+)$/);
    if (streamMatch) return await handleNeteaseStream(req, res, streamMatch[1], u.searchParams);
    if (urlPath === "/api/events") return sseHandler(req, res);
    if (urlPath.startsWith("/api/")) return await handleApi(req, res, urlPath);
    return serveStatic(req, res, urlPath);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
  }
});

onEvent(broadcast);

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ╭─────────────────────────────────────────────╮");
  console.log("  │   小爱音箱控制台                            │");
  console.log(`  │   http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`.padEnd(46) + "│");
  console.log("  ╰─────────────────────────────────────────────╯");
  console.log("");
  boot().catch((e) => {
    console.error("启动失败：", e?.message ?? e);
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n❌ 端口 ${PORT} 已被占用。换个端口：PORT=3001 node server.mjs\n`);
    process.exit(1);
  }
  throw e;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n正在退出…");
    server.close();
    process.exit(0);
  });
}
