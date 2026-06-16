#!/bin/bash
set -e

# cc-haha 启动脚本
# 同时启动后端服务和桌面前端

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:$PATH"

cd "$SCRIPT_DIR"

SERVER_PORT=3456
DESKTOP_PORT=1420

# 检查端口是否被占用
check_port() {
  local port=$1
  if lsof -i :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0  # 端口已被占用
  else
    return 1  # 端口空闲
  fi
}

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

# 检查端口占用
if check_port $SERVER_PORT; then
  echo "❌ 端口 $SERVER_PORT 已被占用，请先释放该端口"
  exit 1
fi
if check_port $DESKTOP_PORT; then
  echo "❌ 端口 $DESKTOP_PORT 已被占用，请先释放该端口"
  exit 1
fi

# 启动后端服务
echo "[1/2] 启动后端服务 (端口 $SERVER_PORT)..."
SERVER_PORT=$SERVER_PORT bun run src/server/index.ts &
SERVER_PID=$!

# 等待后端就绪
for i in $(seq 1 15); do
  sleep 1
  if curl -s http://localhost:$SERVER_PORT/health >/dev/null 2>&1; then
    echo "      后端已就绪 ✓"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "❌ 后端启动超时，请检查日志"
    exit 1
  fi
done

# 启动桌面前端
echo "[2/2] 启动桌面前端 (端口 $DESKTOP_PORT)..."
cd "$SCRIPT_DIR/desktop"
bun run dev &
DESKTOP_PID=$!

echo ""
echo "=================================="
echo "  启动成功！"
echo "  桌面端: http://localhost:$DESKTOP_PORT"
echo "  Ctrl+C 停止所有服务"
echo "=================================="

wait
