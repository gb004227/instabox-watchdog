import config from "./config.js";
import { getMiNA } from "@mi-gpt/miot";

const { userId, password, passToken, did } = config.speaker;
const mina = await getMiNA({ userId, password, passToken, did });
if (!mina) { console.error("登录失败"); process.exit(1); }

const conv = await mina.getConversations({ limit: 12, timestamp: Date.now() });
const records = conv?.records ?? [];
console.log("记录数:", records.length, "\n");

for (const r of records) {
  const t = new Date(r.time).toLocaleString("zh-CN");
  const ans = (r.answers ?? []).map((a) => a.type).join("+");
  console.log(`[${t}] 问: ${r.query}`);
  console.log(`           答(${(r.answers ?? []).length}条, ${ans || "无"}): ${(r.answers ?? []).map((a) => (a.text ?? "").slice(0, 40)).join(" | ")}`);
  console.log(`           MiGPT 是否会处理: ${(r.answers?.length === 1 && ["TTS", "LLM"].includes(r.answers[0]?.type)) ? "是" : "否(被过滤)"}`);
  console.log();
}
