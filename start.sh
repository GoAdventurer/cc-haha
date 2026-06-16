#!/bin/bash
set -e

# cc-haha 启动脚本
# 同时启动后端服务和桌面前端

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:$PATH"

cd "$SCRIPT_DIR"

cleanup() {
  echo ""
  echo "正在关闭服务..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$DESKTOP_PID" ] && kill "$DESKTOP_PID" 2>/dev/null
  wait 2>/dev/null
  echo "已退出"
}
trap cleanup EXIT INT TERM

echo "=================================="
echo "  cc-haha 启动中..."
echo "=================================="
echo ""

# 启动后端服务
echo "[1/2] 启动后端服务 (端口 3456)..."
SERVER_PORT=3456 bun run src/server/index.ts &
SERVER_PID=$!
sleep 2

# 启动桌面前端
echo "[2/2] 启动桌面前端 (端口 1420)..."
cd "$SCRIPT_DIR/desktop"
bun run dev &
DESKTOP_PID=$!

echo ""
echo "=================================="
echo "  启动成功！"
echo "  桌面端: http://localhost:1420"
echo "  Ctrl+C 停止所有服务"
echo "=================================="

wait
