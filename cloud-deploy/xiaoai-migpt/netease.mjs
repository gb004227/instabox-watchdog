/**
 * 网易云音乐接入 —— 搜索、直链、歌单、cookie 管理
 *
 * 两种模式（由有没有 cookie 决定）：
 *   游客模式（默认）：能搜能播，但主流版权歌拿不到 URL，只能播翻唱/游客曲库版本
 *   登录模式：控制台粘贴 MUSIC_U cookie，完整正版曲库；VIP 歌曲还需要账号本身有会员
 *
 * cookie 保存位置：netease.json（已加入 .gitignore，等同账号凭据，勿外传）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NETEASE_FILE = path.join(ROOT, "netease.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 批量查 URL 时的单次上限，太大容易被限流 */
const BATCH = 20;

/* ══════════════════════ cookie 存取 ══════════════════════ */

export function readNetease() {
  // 云端容器优先读环境变量（凭据不落镜像），本地仍可用 netease.json
  if (process.env.NETEASE_COOKIE) {
    return { cookie: process.env.NETEASE_COOKIE, nickname: process.env.NETEASE_NICKNAME ?? "" };
  }
  try {
    const d = JSON.parse(fs.readFileSync(NETEASE_FILE, "utf8"));
    return { cookie: d.cookie ?? "", nickname: d.nickname ?? "" };
  } catch {
    return { cookie: "", nickname: "" };
  }
}

export function writeNetease(data) {
  const tmp = `${NETEASE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, NETEASE_FILE);
}

export function clearNetease() {
  try {
    fs.unlinkSync(NETEASE_FILE);
  } catch {
    /* 本来就没有 */
  }
}

/* ══════════════════════ 底层请求 ══════════════════════ */

function headers(cookie) {
  const h = { "User-Agent": UA, Referer: "https://music.163.com" };
  if (cookie) h.Cookie = cookie;
  return h;
}

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const url = `https://music.163.com${pathname}`;
  const opt = { method, headers: headers(cookie) };
  if (body) {
    opt.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opt.body =
      typeof body === "string" ? body : new URLSearchParams(body).toString();
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`网易云接口异常（HTTP ${r.status}）`);
  return j;
}

/* ══════════════════════ 核心能力 ══════════════════════ */

/** 搜索歌曲（type=1 单曲）。游客返回的是游客曲库，登录返回完整曲库 */
export async function searchSong(keyword, cookie, limit = 10) {
  const j = await api("/api/search/get/", {
    method: "POST",
    body: { s: keyword, type: 1, offset: 0, limit },
    cookie,
  });
  return (j?.result?.songs ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    artist: (s.artists ?? []).map((a) => a.name).join("/"),
    fee: s.fee,
  }));
}

/** 批量拿播放直链。返回与入参同序的数组，url 为 null 表示无版权/不可播 */
export async function getSongUrls(ids, cookie, br = 320000) {
  if (!ids.length) return [];
  const j = await api(`/api/song/enhance/player/url?ids=[${ids.join(",")}]&br=${br}`, { cookie });
  return (j?.data ?? []).map((d) => ({
    id: d.id,
    url: d.url ?? null,
    br: d.br ?? 0,
    fee: d.fee,
    type: d.type ?? "mp3",
  }));
}

/**
 * 判断搜索结果是不是翻唱/非原唱版本。
 * 背景：周杰伦等歌手的正版 2018 年起不在网易云曲库，搜索结果里全是翻唱，
 * 直接挑第一首可播的会播到「深情版/钢琴版」这类翻唱，用户听起来像试听版。
 */
const COVER_RE =
  /翻唱|原唱|深情|钢琴|吉他|伴奏|铃声|DJ|抖音|[Dd]emo|[Cc]over|[Rr]emix|纯音乐|史诗|史詩|Live|现场|現場|8D|[Ss]lowed|sped up|remix|现场版/;

function looksCover(name, artist) {
  // 「（XX版）」「(XX版)」这类括号变体（含繁体）基本都是二创/翻唱
  const bracketVariant = /[（(][^）)]*版[)）]/.test(name);
  return COVER_RE.test(name) || COVER_RE.test(artist) || bracketVariant;
}

/**
 * 批量分类候选：正版 vs 翻唱/搬运号。
 * 三重信号：① originCoverType=2（官方翻唱标记）② 歌名/歌手特征词 ③ 唱片公司缺失或「独立发行」。
 * 周杰伦这类已下架歌手的正版不在结果里，剩下的「晴天 - 梦里啥都有」就是搬运号，
 * 只能靠公司字段识别（正版必有真实厂牌，如 Universal Music Ltd.）。
 */
async function classifySongs(songs, cookie) {
  if (!songs.length) return songs;
  const ids = songs.slice(0, BATCH).map((s) => s.id).join(",");
  const j = await api(`/api/song/detail?ids=[${ids}]`, { cookie }).catch(() => null);
  const detail = new Map((j?.songs ?? []).map((d) => [d.id, d]));
  return songs.map((s) => {
    const d = detail.get(s.id);
    const company = d?.album?.company ?? "";
    const isCover =
      d?.originCoverType === 2 ||
      looksCover(s.name, s.artist) ||
      !company ||
      company === "独立发行";
    return { ...s, cover: isCover };
  });
}

/**
 * 找一首可播放的歌：搜前 10 个候选 → 批量查直链 → 返回第一个有 URL 的。
 * preferOfficial：先挑正版候选；全是翻唱且不允许翻唱时返回 null。
 * 返回值带 cover 标记，调用方可提示「这是翻唱版」。
 */
/** 相关性：候选必须真的和点播词对得上，否则「搜晴天→放了像晴天像雨天」这种答非所问 */
function isRelevant(name, artist, keyword) {
  const norm = (x) => x.replace(/[\s·・（）()\-'’"]/g, "").toLowerCase();
  const kw = norm(keyword);
  const n = norm(name);
  if (n === kw || n.startsWith(kw) || (kw.startsWith(n) && n.length >= 2)) return true;
  const a = norm(artist);
  return a.length >= 2 && (a.includes(kw) || kw.includes(a));
}

export async function findPlayable(keyword, cookie, br = 320000, allowCover = true) {
  const raw = await searchSong(keyword, cookie);
  if (!raw.length) return null;
  const songs = (await classifySongs(raw, cookie)).filter((s) =>
    isRelevant(s.name, s.artist, keyword),
  );
  if (!songs.length) return null;
  const urls = await getSongUrls(songs.map((s) => s.id), cookie, br);
  const okMap = new Map(urls.filter((u) => u.url).map((u) => [u.id, u]));

  const official = [];
  const covers = [];
  for (const s of songs) {
    const u = okMap.get(s.id);
    if (!u) continue;
    (s.cover ? covers : official).push({ ...s, url: u.url, br: u.br });
  }
  return official[0] ?? (allowCover ? covers[0] : null);
}

/**
 * 随机模式（「放首歌」这种没指定歌名的说法）：
 * 从歌单里挑可播的。playlistId 默认 3778678 = 云音乐热歌榜。
 */
export async function pickRandom(cookie, br = 320000, playlistId = "3778678", allowCover = true) {
  const j = await api(`/api/playlist/detail?id=${playlistId}&n=100`, { cookie });
  const tracks = (j?.result?.tracks ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join("/"),
    fee: t.fee,
  }));
  if (!tracks.length) return null;

  // 分批查直链 + 分类，官方版优先，翻唱只在 allowCover 时作为备选
  const official = [];
  const covers = [];
  for (let i = 0; i < tracks.length && official.length < 5; i += BATCH) {
    const batch = tracks.slice(i, i + BATCH);
    const [classified, urls] = await Promise.all([
      classifySongs(batch, cookie),
      getSongUrls(batch.map((t) => t.id), cookie, br),
    ]);
    const okMap = new Map(urls.filter((u) => u.url).map((u) => [u.id, u]));
    for (const t of classified) {
      const u = okMap.get(t.id);
      if (!u) continue;
      (t.cover ? covers : official).push({ ...t, url: u.url, br: u.br });
      if (official.length >= 5) break;
    }
  }
  const pool = official.length ? official : allowCover ? covers : [];
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 拉用户昵称与会员状态，用于验证 cookie 是否有效 */
export async function whoAmI(cookie) {
  if (!cookie) return null;
  const j = await api("/api/nuser/account/get", { cookie }).catch(() => null);
  const p = j?.profile;
  if (!p?.nickname) return null;
  // vipType: 0=无 11=音乐包 12=黑胶 13=超级黑胶；110 是「曾开通但已过期」的历史标记
  return { nickname: p.nickname, userId: p.userId, vipType: p.vipType ?? 0 };
}
