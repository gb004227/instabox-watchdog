#!/usr/bin/env python3
# 端到端验证：让音箱播放歌单里的第一首，并回读播放状态
import json, urllib.request, urllib.parse, time, sys

XM = "http://127.0.0.1:8090"
DID = "980664431"   # Xiaomi 智能音箱 Pro

def post(path, payload):
    req = urllib.request.Request(
        XM + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")

def get(path):
    with urllib.request.urlopen(XM + path, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

# 1. 从歌单里挑第一首歌
pl = json.loads(get("/curplaylist"))
print("[歌单] 当前歌单:", pl.get("cur_playlist") if isinstance(pl, dict) else type(pl))
names = json.loads(get("/playlistnames"))
first_pl = names[0] if isinstance(names, list) and names else None
print("[歌单] 可用歌单数:", len(names) if isinstance(names, list) else "?")

song = None
if first_pl:
    musics = json.loads(get("/playlistmusics?name=" + urllib.parse.quote(first_pl)))
    lst = musics.get("musics") if isinstance(musics, dict) else musics
    if lst:
        song = lst[0]
        print("[选中] 歌单=%s  曲目=%s" % (first_pl, song.get("name") if isinstance(song, dict) else song))
if not song:
    song = {"name": "晴天"}
    print("[选中] 回退曲目: 晴天")

song_name = song.get("name") if isinstance(song, dict) else str(song)

# 2. 下发播放
print("[下发] playmusic did=%s name=%s" % (DID, song_name))
try:
    print("[返回]", post("/playmusic", {"did": DID, "musicname": song_name, "searchkey": song_name})[:200])
except Exception as e:
    print("[返回] ERROR", e)

# 3. 等设备响应并回读状态
for i in range(6):
    time.sleep(5)
    try:
        st = json.loads(get("/playingmusic?did=" + DID))
        cur = st.get("cur_music") if isinstance(st, dict) else None
        status = st.get("status") if isinstance(st, dict) else None
        print("[状态 %ds] cur_music=%r status=%r" % ((i + 1) * 5, cur, status))
        if cur:
            break
    except Exception as e:
        print("[状态] ERROR", e)
