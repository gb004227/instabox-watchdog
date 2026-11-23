/**
 * 真机出声测试：登录 → 设音量 → 让音箱朗读一句话
 * 运行：node test-speaker.mjs ["要说的话"]
 */

import config from "./config.js";
import { getMiNA } from "@mi-gpt/miot";

const text = process.argv[2] ?? "配置验证成功，现在我可以接入大模型了";

const { userId, password, passToken, did } = config.speaker;

console.log("🔑 登录小米账号…");
const mina = await getMiNA({ userId, password, passToken, did });
if (!mina) {
  console.error("❌ 登录失败");
  process.exit(1);
}

const devices = await mina.getDevices();
const dev = devices.find((d) => (d.name ?? d.deviceName) === did);
if (!dev) {
  console.error(`❌ 找不到设备：${did}`);
  process.exit(1);
}
console.log(`✅ 目标设备：${dev.name} [${dev.model ?? dev.hardware}]`);

const v = await mina.setVolume(45);
console.log(`🔉 设置音量 45：${v ? "成功" : "失败"}`);

console.log(`🔊 播放 TTS：「${text}」`);
const played = await mina.play({ text });
console.log(played ? "✅ 音箱已响应，应该正在朗读" : "❌ 播放指令被拒绝");

// 顺带看一眼播放状态（OH2P 可能读不到，属正常）
const st = await mina.getStatus();
console.log(st ? `ℹ️ 状态：${st.status} 音量=${st.volume}` : "ℹ️ 播放状态不可读（OH2P 已知情况）");
