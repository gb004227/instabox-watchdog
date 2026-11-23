/**
 * MiGPT 启动核心 —— 被 index.mjs（纯命令行）和 server.mjs（Web 控制台）共用
 *
 * 职责：
 *   1. 合并配置（config.js 打底 + runtime.json 覆盖，后者由 Web 控制台写入）
 *   2. 给 @mi-gpt/next 打两个补丁（abortXiaoAI 打断、play 结果可观测）
 *   3. 把「用户说话 / AI 回答 / 日志 / 状态」变成事件，供 SSE 推送
 *   4. 支持不重启进程的热重启（改完配置即时生效）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import baseConfig from "./config.js";
import { findPlayable, pickRandom, readNetease } from "./netease.mjs";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_FILE = path.join(ROOT, "runtime.json");

/** config.js 里的出厂词表：取消「全部接管」时用它回填，保证能退回原状态 */
export const BASE_KEYWORDS = baseConfig.callAIKeywords ?? [];

/* ══════════════════════ 配置合并 ══════════════════════ */

function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? deepMerge(target?.[k] ?? {}, v)
        : v;
  }
  return out;
}

/** 读取 Web 控制台保存的覆盖配置 */
export function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 原子写入覆盖配置 */
export function writeRuntime(patch) {
  const next = deepMerge(readRuntime(), patch);
  const tmp = `${RUNTIME_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, RUNTIME_FILE);
  return next;
}

/** config.js 与 runtime.json 合并后的最终配置 */
export function effectiveConfig() {
  const rt = readRuntime();
  return {
    ...baseConfig,
    speaker: { ...baseConfig.speaker, ...(rt.speaker ?? {}) },
    openai: { ...baseConfig.openai, ...(rt.openai ?? {}) },
    prompt: { ...baseConfig.prompt, ...(rt.prompt ?? {}) },
    music: { ...baseConfig.music, ...(rt.music ?? {}) },
    callAIKeywords: rt.callAIKeywords ?? baseConfig.callAIKeywords,
    onMessage: baseConfig.onMessage,
  };
}

/* ══════════════════════ 事件总线 ══════════════════════ */

const listeners = new Set();
const history = [];
const HISTORY_MAX = 400;

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getHistory(limit = 200) {
  return history.slice(-limit);
}

function emit(type, data = {}) {
  const e = { type, time: Date.now(), ...data };
  history.push(e);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* 单个订阅者异常不影响其他人 */
    }
  }
}

/* ══════════════════════ 运行状态 ══════════════════════ */

let MiGPT = null;
let booted = false;

export function getEngine() {
  return MiGPT;
}

export function getStatus() {
  return {
    running: MiGPT?.status === "running",
    device: effectiveConfig().speaker.did,
    startedAt: booted ? startupTime : null,
  };
}

/* ══════════════════════ 补丁 ══════════════════════ */

function applyPatches() {
  // 补丁 1：官方把 abortXiaoAI 写成了空实现，导致 AI 回答永远抢不过小爱原生回答
  MiGPT.speaker.abortXiaoAI = async () => {
    const mina = MiGPT.MiNA;
    if (!mina) return false;
    try {
      const ok = await mina.stop();
      emit("log", { level: ok ? "log" : "warn", text: `↳ 打断原生播报：${ok ? "已发送 stop" : "stop 被拒"}` });
      return ok;
    } catch (e) {
      emit("log", { level: "error", text: `↳ 打断失败：${e?.message ?? e}` });
      return false;
    }
  };

  // 补丁 2：引擎只打印文本就调用 play，失败时异常被吞掉；这里把真实结果暴露出来
  // 音乐（url 播放）走独立的 music 事件，不进 ai 对话流，避免重复
  const origPlay = MiGPT.speaker.play.bind(MiGPT.speaker);
  MiGPT.speaker.play = async (arg) => {
    const t = Date.now();
    try {
      const r = await origPlay(arg);
      const ms = Date.now() - t;
      if (arg?.text) {
        // latency = 从收到你说的话到真正开口播报，含轮询等待 + 打断 + 模型生成
        const latency = pendingUserAt ? Date.now() - pendingUserAt : null;
        emit("ai", { text: arg.text, ok: r === true, ms, latency });
      } else if (arg?.url) {
        emit("log", { level: r === true ? "log" : "warn", text: `↳ 音频流下发：${r === true ? "成功" : "被拒"}  耗时 ${ms}ms` });
      }
      return r;
    } catch (e) {
      emit("log", { level: "error", text: `↳ ❌ 播报失败：${e?.message ?? e}` });
      throw e;
    }
  };
}

/* ══════════════════════ 日志劫持 ══════════════════════ */

/** 不值得推到界面的噪音：启动 banner、Node 弃用警告、底层库的调试输出 */
function isNoise(text) {
  return (
    text.includes("$$$$$$") ||          // MiGPT ASCII banner
    text.includes("| $$") ||
    text.includes("__/") ||
    text.includes("DeprecationWarning") ||
    text.includes("punycode") ||
    text.includes("trace-deprecation") ||
    text.trim().length === 0
  );
}

function hookConsole() {
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : String(a)))
        .join(" ");
      // 引擎的 🔥/🔊 已经由结构化事件上报，日志里跳过避免重复
      if (!text.startsWith("🔥") && !text.startsWith("🔊") && !isNoise(text)) {
        emit("log", { level, text: text.slice(0, 500) });
      }
      orig(...args);
    };
  }
}

/* ══════════════════════ 启停 ══════════════════════ */

let pendingUserAt = 0;
let startupTime = null;
let loopToken = 0;

/**
 * 原生指令：小爱自己能处理得更好（调音量、放歌、闹钟、开关灯）。
 * 只在「全部接管」模式下才用来兜底 —— 否则说「音量30」会被转给大模型，
 * 变成 AI 嘴上答应、原生功能被打断。
 */
const NATIVE_PATTERNS = [
  /^(音量|声音|大声|小声|静音|取消静音)/,
  /^(播放|暂停|继续|停止|下一首|上一首|换一首|切歌|单曲循环|随机播放)/,
  /^(闹钟|定.{0,3}闹钟|提醒我|倒计时|计时器)/,
  /^(开灯|关灯|打开|关闭|调到)/,
  /^(现在几点|几点|今天.{0,1}[几号日]|日期|星期几)/,
  /^(别说了|闭嘴|安静|退下)/,
  // 音乐类不限句首：「我想听首歌」「放首歌」都要让给小爱原生，否则放不出来
  /(听.{0,2}歌|放.{0,2}歌|唱歌|音乐|歌曲|来一首)/,
];

/** 是否处于「全部接管」模式：callAIKeywords 只有一个空串 */
function isCatchAll(cfg) {
  const kw = cfg.callAIKeywords;
  return Array.isArray(kw) && kw.length === 1 && kw[0] === "";
}

/* ══════════════════════ 网易云音乐点播 ══════════════════════ */

/** 播放控制类交给小爱（暂停/下一首控制的是当前媒体通道，网盘式点播接管不了） */
const MUSIC_CTRL = /^(暂停|继续|停止|下一首|上一首|换一首|切歌|单曲循环|随机播放|音量|声音|大声|小声|静音)/;

/** 点播口令：播放/放/来/我想听/我要听 + 歌名 */
const MUSIC_PLAY = /^(?:播放|放|来|我想听|我要听)(?:一首|个|首)?\s*(.*)$/;

/**
 * 解析音乐点播指令。返回 null 表示不是点播；返回 "" 表示随机一首；否则是歌名。
 */
function parseMusicCommand(text) {
  if (MUSIC_CTRL.test(text)) return null;
  const m = text.match(MUSIC_PLAY);
  if (!m) return null;
  let want = (m[1] ?? "").replace(/(的歌曲|这首歌|歌曲|的歌)$/g, "").trim();
  if (!want || /^(歌|首歌|音乐|个歌)$/.test(want)) want = "";
  return want;
}

/** 网易云找歌并推给音箱；失败返回 undefined，让流程继续（关键词模式→小爱原生兜底） */
export async function playFromNetease(engine, want) {
  const t0 = Date.now();
  const { cookie } = readNetease();
  const mode = cookie ? "登录" : "游客";
  // allowCover: null=自动（登录后拒翻唱，游客接受），true/false 强制
  const allowCover =
    effectiveConfig().music?.allowCover ?? (cookie ? false : true);
  emit("log", {
    level: "log",
    text: `🎵 网易云点播（${mode}模式${allowCover ? "" : "·只挑正版"}）：${want || "随机一首"}`,
  });

  try {
    const song = want
      ? await findPlayable(want, cookie, 320000, allowCover)
      : await pickRandom(cookie, 320000, undefined, allowCover);
    if (!song) {
      emit("log", {
        level: "warn",
        text: "🎵 没有可用的正版版本（这首歌可能不在网易云曲库，如周杰伦），交给小爱原生",
      });
      return undefined;
    }
    if (song.cover) {
      emit("log", { level: "warn", text: `🎵 正版不可播，使用翻唱版：${song.name} - ${song.artist}` });
    }
    // 先打断当前播放（小爱可能在说话），再下发音频流
    await engine.MiNA.stop?.().catch?.(() => {});
    const ok = await engine.MiNA.play({ url: song.url });
    emit("music", {
      title: song.name,
      artist: song.artist,
      cover: song.cover ?? false,
      ok: ok === true,
      ms: Date.now() - t0,
      mode,
    });
    return { handled: true };
  } catch (e) {
    emit("log", { level: "error", text: `🎵 网易云出错：${e?.message ?? e}` });
    return undefined;
  }
}

function wrapOnMessage(cfg) {
  const orig = cfg.onMessage;
  const catchAll = isCatchAll(cfg);
  const musicEnabled = cfg.music?.enabled !== false;
  const musicSource = cfg.music?.source ?? "netease";

  cfg.onMessage = async (engine, msg) => {
    pendingUserAt = Date.now();
    const text = String(msg?.text ?? "");
    emit("user", { text });

    // 1. 音乐点播优先级最高
    if (musicEnabled) {
      const want = parseMusicCommand(text);
      if (want !== null) {
        if (musicSource === "xiaomusic") {
          // xiaomusic 自己在轮询语音指令（enable_pull_ask），点播/下载/播放全由它完成；
          // 这里只需让 MiGPT 静默（不搜网易云、不走大模型），不干扰即可
          emit("log", {
            level: "log",
            text: `🎵 音乐口令交给 xiaomusic 处理：${text}`,
          });
          return { handled: true };
        }
        const r = await playFromNetease(engine, want);
        if (r) return r; // 点播成功；失败（undefined）继续往下走小爱兜底
      }
    }

    // 2. 全接管模式下的原生指令保护
    if (catchAll && NATIVE_PATTERNS.some((re) => re.test(text))) {
      emit("log", { level: "log", text: `↳ 原生指令，交给小爱处理：${text}` });
      return { handled: true }; // 只让 MiGPT 静默，不影响小爱自己执行
    }

    return orig ? orig.call(cfg, engine, msg) : undefined;
  };
  return cfg;
}

/** 启动主循环（MiGPT.start 内部是死循环，不能 await） */
function startLoop() {
  const cfg = wrapOnMessage(effectiveConfig());
  startupTime = Date.now();
  emit("status", { running: true, device: cfg.speaker.did });
  MiGPT.start(cfg).catch((e) => {
    emit("status", { running: false, error: e?.message ?? String(e) });
    emit("log", { level: "error", text: `启动失败：${e?.message ?? e}` });
  });
}

/** 初始化：加载依赖、打补丁、启动 */
export async function boot() {
  if (booted) return { MiGPT, restart };
  const mod = await import("@mi-gpt/next");
  MiGPT = mod.MiGPT;
  applyPatches();
  hookConsole();
  booted = true;
  startLoop();
  return { MiGPT, restart };
}

/** 热重启：停掉轮询循环，用新配置重新拉起（不重启进程，Web 服务不掉线） */
export async function restart() {
  if (!MiGPT) return false;
  const token = ++loopToken;
  emit("status", { running: false, reason: "restarting" });
  emit("log", { level: "log", text: "♻️ 正在应用新配置…" });

  await MiGPT.stop();
  await new Promise((r) => setTimeout(r, 900));
  if (token !== loopToken) return false; // 被更晚的重启请求取代

  startLoop();
  emit("log", { level: "log", text: "✅ 新配置已生效" });
  return true;
}
