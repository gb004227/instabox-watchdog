/**
 * 辅助脚本：登录小米账号，列出账号下所有小爱设备
 * 用途：确认 config.js 里 speaker.did 应该填什么（必须和这里打印的 name 完全一致）
 *
 * 运行：node devices.mjs
 */

import config from "./config.js";
import { getMiNA } from "@mi-gpt/miot";

const { userId, password, passToken } = config.speaker ?? {};

if (!passToken && (!userId || userId.startsWith("xxx") || !password || password.startsWith("xxx"))) {
  console.error("\n❌ 请先在 config.js 里填写 speaker.userId 和 speaker.password（或 passToken）\n");
  process.exit(1);
}

console.log("🔑 正在登录小米账号…");
const mina = await getMiNA({ userId, password, passToken, debug: false });

if (!mina) {
  console.error("\n❌ 登录失败。常见原因：触发了小米安全验证 → 改用 passToken 登录（见 README 第 3 步）\n");
  process.exit(1);
}

const devices = await mina.getDevices();

if (!Array.isArray(devices) || !devices.length) {
  console.error("\n❌ 没查到设备。确认这台音箱是用「当前账号」绑定的（别人共享给你的设备查不到）\n");
  process.exit(1);
}

console.log(`\n✅ 账号下共 ${devices.length} 台小爱设备：\n`);
for (const d of devices) {
  console.log(`  名称: ${d.name}`);
  console.log(`  型号: ${d.model ?? d.hardware ?? "-"}`);
  console.log(`  设备ID: ${d.deviceID ?? d.did ?? "-"}`);
  console.log("");
}

console.log("👉 把上面 OH2P 对应的「名称」填进 config.js 的 speaker.did\n");
