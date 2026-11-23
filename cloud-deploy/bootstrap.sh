#!/usr/bin/env bash
# 全新 Ubuntu/Debian 服务器从零到可用：装 Docker → 检查 swap → 跑 deploy.sh
# 用法：bash bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> 安装 Docker（官方脚本）"
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker
fi
docker info >/dev/null 2>&1 || { echo "==> 启动 docker"; systemctl start docker; }

# 2G 内存的机器构建 npm/pip 容易 OOM，自动补 2G swap
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && [ ! -f /swapfile ]; then
  echo "==> 内存 ${MEM_MB}MB，创建 2G swap"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

[ -f .env ] || { echo "缺少 .env，先 cp .env.example .env 并填写"; exit 1; }
if grep -q 'REPLACE_WITH_SERVER_IP' .env; then
  echo "!! .env 里 PUBLIC_HOSTNAME 还是占位符"
  echo "   改成 http://<本机公网IP> 后重新执行：bash deploy.sh"
  echo "   当前公网 IP 看起来是：$(curl -fsS -m 5 https://api.ipify.org || echo '(取不到)')"
  exit 1
fi

exec bash deploy.sh
