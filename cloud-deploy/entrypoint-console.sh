#!/bin/sh
set -e

# runtime.json 会覆盖 config.js，所以云端把模型/接口地址也写进 runtime.json
if [ -n "$OPENAI_BASE_URL" ] || [ -n "$OPENAI_MODEL" ]; then
  node -e '
    const fs = require("fs");
    const f = "/app/runtime.json";
    let d = {};
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    d.openai = d.openai || {};
    if (process.env.OPENAI_BASE_URL) d.openai.baseURL = process.env.OPENAI_BASE_URL;
    if (process.env.OPENAI_MODEL) d.openai.model = process.env.OPENAI_MODEL;
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  '
fi

echo "[entrypoint] 启动控制台 :3000, xiaomusic=${XIAOMUSIC_URL}"
exec node server.mjs
