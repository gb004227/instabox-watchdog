/**
 * 联通性自检：验证 1) 大模型接口  2) 小米账号登录  3) 音箱设备匹配
 * 运行：node check.mjs
 */

import config from "./config.js";

const mask = (s = "") => (s.length > 10 ? `${s.slice(0, 5)}***${s.slice(-4)}` : "***");
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => console.log(`❌ ${m}`);

let fail = 0;

/* ---------- 1. 配置完整性 ---------- */
console.log("\n【1】配置检查");
const { userId, password, did, passToken } = config.speaker ?? {};
const { model, baseURL, apiKey } = config.openai ?? {};

console.log(`   userId   = ${userId}`);
console.log(`   password = ${password ? "已填写(" + password.length + "位)" : "空"}`);
console.log(`   did      = ${did}`);
console.log(`   model    = ${model}`);
console.log(`   baseURL  = ${baseURL}`);
console.log(`   apiKey   = ${apiKey ? mask(apiKey) : "空"}`);

if (!/^\d+$/.test(String(userId ?? ""))) {
  bad(`userId 必须是纯数字（小米 ID），当前是 "${userId}"`);
  fail++;
} else {
  ok(`userId 是纯数字，${String(userId).length} 位`);
}

/* ---------- 2. 大模型接口 ---------- */
console.log("\n【2】大模型接口");

const base = String(baseURL).replace(/\/+$/, "");
const candidates = [`${base}/chat/completions`, `${base}/v1/chat/completions`];

let aiPassed = false;
for (const url of candidates) {
  process.stdout.write(`   → POST ${url}\n`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "回复两个字：正常" }],
        // 注意：deepseek 这类混合推理模型会先消耗 reasoning tokens，
        // max_tokens 给太小会导致 content 为空，看起来像"接口没返回"
        max_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch {}

    if (res.ok && json?.choices?.[0]?.message) {
      ok(`接口可用，模型回复：「${json.choices[0].message.content.trim()}」`);
      aiPassed = true;
      break;
    }

    const errMsg = json?.error?.message ?? txt.slice(0, 200);
    bad(`HTTP ${res.status} — ${errMsg}`);
    if (/model/i.test(errMsg)) {
      console.log(`     ↳ 模型名 "${model}" 不被该服务识别，DeepSeek 应填 deepseek-chat 或 deepseek-reasoner`);
    }
    if (res.status === 401) {
      console.log(`     ↳ Key 无效或已失效`);
      break;
    }
  } catch (e) {
    bad(`请求失败：${e.cause?.code ?? e.name} ${e.message}`);
  }
}

if (!aiPassed) fail++;

/* ---------- 3. 小米账号 + 设备 ---------- */
console.log("\n【3】小米账号登录 & 设备列表");
if (process.env.SKIP_MI === "1") {
  console.log("   (已跳过：SKIP_MI=1，避免反复请求触发小米风控)");
} else try {
  const { getMiNA } = await import("@mi-gpt/miot");
  const mina = await getMiNA({ userId, password, passToken, did, debug: false });

  if (!mina) {
    bad("登录失败 —— 多半是触发了小米安全验证，需改用 passToken（见 README 第 4 节）");
    fail++;
  } else {
    ok("小米账号登录成功");
    const devices = await mina.getDevices();
    if (!Array.isArray(devices) || !devices.length) {
      bad("账号下查不到任何小爱设备（共享设备查不到，必须主账号）");
      fail++;
    } else {
      console.log(`\n   账号下共 ${devices.length} 台设备：`);
      for (const d of devices) {
        const name = d.name ?? d.deviceName ?? "(无名)";
        const mark = name === did ? " 👈 与 did 匹配" : "";
        console.log(`   • ${name}  [${d.model ?? d.hardware ?? "?"}]${mark}`);
      }
      const hit = devices.find((d) => (d.name ?? d.deviceName) === did);
      if (hit) {
        ok(`did 匹配成功：${did}`);
        const st = await mina.getStatus();
        if (st) {
          ok(`设备状态可读：status=${st.status} volume=${st.volume}`);
        } else {
          console.log(`   ⚠️ 播放状态读取失败（不影响基本对话，只是查不到在播什么）`);
        }
      } else {
        bad(`did "${did}" 没匹配到任何设备，请按上面列表原样复制`);
        fail++;
      }
    }
  }
} catch (e) {
  bad(`登录过程异常：${e.message}`);
  fail++;
}

/* ---------- 汇总 ---------- */
console.log("\n" + "=".repeat(46));
if (fail === 0) {
  console.log("🎉 全部通过，可以启动：npm start");
} else {
  console.log(`⚠️ 有 ${fail} 项未通过，按上面提示修 config.js 后重跑本脚本`);
}
console.log("=".repeat(46) + "\n");
