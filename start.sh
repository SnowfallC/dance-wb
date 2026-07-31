#!/usr/bin/env bash
# 启动脚本：在本机运行「舞刀」工作台
# 用法：
#   ./start.sh            # 默认 8000 端口
#   ./start.sh 9000       # 指定端口
# 然后用浏览器（手机同 WiFi 下用电脑内网 IP）访问 http://<本机IP>:端口
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "▶ 启动 舞刀 工作台，端口 $PORT …"
exec python3 serve.py "$PORT"
