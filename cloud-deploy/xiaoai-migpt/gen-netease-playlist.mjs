/**
 * 网易云歌单 → xiaomusic 网络歌单 JSON（hanxi/xiaomusic#78 格式）
 *
 *   node gen-netease-playlist.mjs
 *
 * 读取 netease.json 的登录 cookie，拉取账号全部歌单的完整曲目，
 * 生成 public/xiaomusic-playlist.json：
 *
 *   [ { "name": "歌单名", "musics": [ { "name": "歌名-歌手",
 *       "url": "http://127.0.0.1:3000/netease-stream/<歌曲ID>" } ] } ]
 *
 * url 不直接写网易云 CDN 直链（会过期、且需要 cookie），而是指向
 * 控制台的实时解析端点：每次播放由 server.mjs 现取直链 302 过去。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UID = 118428391; // 天使红魔鬼
const JAY_ARTIST_ID = 6452; // 周杰伦
// 本地默认 127.0.0.1；云服务器容器化部署时设 STREAM_BASE=http://console:3000/netease-stream
const STREAM_BASE = process.env.STREAM_BASE ?? "http://127.0.0.1:3000/netease-stream";

const cookie =
  process.env.NETEASE_COOKIE ??
  JSON.parse(fs.readFileSync(path.join(ROOT, "netease.json"), "utf8")).cookie;
const NETEASE_UID = Number(process.env.NETEASE_UID ?? UID);

function neteaseHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookie,
    Referer: "https://music.163.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  };
}

async function api(url, body = "") {
  const r = await fetch(url, {
    method: "POST",
    headers: neteaseHeaders(),
    body: body || "csrf_token=",
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

async function apiGet(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: neteaseHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

function toMusic(s) {
  if (!s?.name) return null;
  const artists = (s.ar ?? s.artists ?? []).map((a) => a.name).filter(Boolean).join(",");
  const name = artists ? `${s.name}-${artists}` : s.name;
  // name 参数：网易云无版权（灰名单）时服务端用它搜 B 站兜底
  return {
    name,
    url: `${STREAM_BASE}/${s.id}?name=${encodeURIComponent(name)}`,
  };
}

/** 拉取周杰伦全部专辑，生成每专辑歌单（≥5 首）+ 全量合集「周杰伦全部专辑」 */
async function jayAlbums() {
  console.log(`3/4 拉取周杰伦专辑列表（artist ${JAY_ARTIST_ID}）…`);
  const al = await apiGet(
    `https://music.163.com/api/artist/albums/${JAY_ARTIST_ID}?limit=100&offset=0`,
  );
  const albums = al?.hotAlbums ?? [];
  console.log(`   共 ${albums.length} 张专辑`);

  const out = [];
  const all = new Map(); // songId -> music（全量合集去重）

  for (let i = 0; i < albums.length; i++) {
    const a = albums[i];
    const d = await apiGet(`https://music.163.com/api/v1/album/${a.id}`);
    const musics = (d?.songs ?? []).map(toMusic).filter(Boolean);
    if (!musics.length) {
      console.log(`   [${i + 1}/${albums.length}] ${a.name}：无曲目，跳过`);
      continue;
    }
    musics.forEach((m) => all.set(m.url, m));
    // ≥5 首的正式专辑/EP/原声带/演唱会 单独成歌单（1-2 首单曲合集里已有）
    if (musics.length >= 5) {
      const plName = `周杰伦${a.name}`.replace(/[\s()（）]/g, "");
      out.push({ name: plName, musics });
      console.log(`   [${i + 1}/${albums.length}] ${a.name} → ${musics.length} 首`);
    }
    await new Promise((r) => setTimeout(r, 300)); // 限速防风控
  }

  const merged = [...all.values()];
  out.push({ name: "周杰伦全部专辑", musics: merged });
  console.log(`   合集「周杰伦全部专辑」共 ${merged.length} 首（去重后）`);
  return out;
}

async function main() {
  console.log("1/4 拉取用户歌单列表…");
  const r1 = await fetch(
    `https://music.163.com/api/user/playlist?uid=${NETEASE_UID}&limit=100&offset=0`,
    { headers: neteaseHeaders() },
  ).then((x) => x.json());
  const playlists = r1.playlist ?? [];
  console.log(`   共 ${playlists.length} 个歌单`);

  const out = [];

  for (let i = 0; i < playlists.length; i++) {
    const pl = playlists[i];
    console.log(`2/4 [${i + 1}/${playlists.length}] ${pl.name}（${pl.trackCount} 首）拉取曲目…`);

    // 拉完整 trackIds（playlist 列表接口只带前几首）
    const d = await api("https://music.163.com/api/v6/playlist/detail", `id=${pl.id}&n=1000&csrf_token=`);
    const trackIds = (d?.playlist?.trackIds ?? []).map((t) => t.id);
    if (!trackIds.length) {
      console.log("   （空歌单，跳过）");
      continue;
    }

    // 批量拿歌名/歌手（每批 200，ids 是普通数字数组）
    const songs = [];
    for (let off = 0; off < trackIds.length; off += 200) {
      const batch = trackIds.slice(off, off + 200);
      const sd = await apiGet(`https://music.163.com/api/song/detail?ids=[${batch.join(",")}]`);
      songs.push(...(sd?.songs ?? []));
    }

    const musics = songs.map(toMusic).filter(Boolean);

    out.push({ name: pl.name, musics });
    console.log(`   → ${musics.length} 首入库`);
  }

  // 周杰伦全部专辑（固定追加，与用户歌单合并）
  const jay = await jayAlbums();
  for (const p of jay) {
    if (!out.some((x) => x.name === p.name)) out.push(p);
  }

  const total = out.reduce((n, p) => n + p.musics.length, 0);
  const file = path.join(ROOT, "public", "xiaomusic-playlist.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1), "utf8");
  console.log(`\n4/4 已生成 ${file}`);
  console.log(`   ${out.length} 个歌单 / ${total} 首歌（含重复引用）`);
  console.log("\n接下来：POST /api/system/modifiysetting 写 music_list_json，再说「刷新列表」生效。");
}

main().catch((e) => {
  console.error("生成失败：", e?.message ?? e);
  process.exit(1);
});
