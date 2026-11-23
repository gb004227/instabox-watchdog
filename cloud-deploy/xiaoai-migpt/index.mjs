/**
 * 小爱音箱接入大模型 —— 纯命令行入口（不带 Web 界面）
 *
 * 想要图形界面请用：npm run web
 * 设备：Xiaomi 智能音箱 Pro (MiAiSoundbox-OH2P)
 */

import { effectiveConfig, boot } from "./boot.mjs";

const config = effectiveConfig();

const REQUIRED = [
  ["speaker.userId", config.speaker?.userId, "小米 ID（纯数字）"],
  ["speaker.password", config.speaker?.password, "小米账号密码"],
  ["speaker.did", config.speaker?.did, "米家 App 里的音箱名称"],
  ["openai.apiKey", config.openai?.apiKey, "大模型 API Key"],
];

const missing = REQUIRED.filter(
  ([, v]) => !v || String(v).startsWith("xxx") || String(v).startsWith("sk-xxx")
);

if (missing.length) {
  console.error("\n❌ 配置还没填完，缺少以下内容：\n");
  for (const [key, , desc] of missing) console.error(`   • ${key.padEnd(16)} —— ${desc}`);
  console.error("\n请编辑同目录下的 config.js 后重新运行：npm run cli\n");
  process.exit(1);
}

console.log("🔌 正在登录小米账号并连接音箱…");
console.log(`   设备名称：${config.speaker.did}`);

await boot();

// 保持进程常驻（MiGPT.start 内部是轮询死循环，这里负责不让进程退出）
await new Promise(() => {});
