/**
 * 隔离实验：验证「音箱正在播报时，新的 TTS 请求会不会被丢弃」
 *
 * 背景：MiGPT-Next 的 speaker.abortXiaoAI() 是空实现（直接 return false），
 * 所以小爱原生回答不会被中断。若此时 MiGPT 调 play，结果取决于云端 ubus 的行为。
 *
 * 运行：node abort-test.mjs
 */

import config from "./config.js";
import { getMiNA } from "@mi-gpt/miot";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { userId, password, passToken, did } = config.speaker;

const mina = await getMiNA({ userId, password, passToken, did });
if (!mina) {
  console.error("❌ 登录失败");
  process.exit(1);
}

const LONG = "请仔细听这是一段比较长的测试语音用来确认音箱当前正在播报时收到新指令会发生什么情况";
const SHORT = "第二句";

console.log("【实验 1】空闲状态直接播报 —— 应能完整听到");
console.log(`  🔊 长句：${LONG}`);
const r1 = await mina.play({ text: LONG });
console.log(`  返回：${JSON.stringify(r1)}`);

await sleep(1500); // 让它开始念，此时处于「正在播报」

console.log("\n【实验 2】正在播报时插入新指令 —— 观察是否被打断");
console.log(`  🔊 短句：${SHORT}`);
const r2 = await mina.play({ text: SHORT });
console.log(`  返回：${JSON.stringify(r2)}`);

await sleep(1500);

console.log("\n【实验 3】先 stop 再播报 —— 若实验 2 失败，这条路径可作替代方案");
const s = await mina.stop();
console.log(`  stop 返回：${s}`);
await sleep(800);
console.log(`  🔊 播报：中断后重新开始播报`);
const r3 = await mina.play({ text: "中断后重新开始播报" });
console.log(`  返回：${JSON.stringify(r3)}`);

const st = await mina.getStatus();
console.log(`\nℹ️ 最终状态：${st ? `${st.status} 音量=${st.volume}` : "不可读"}`);
