#!/bin/bash

# cc-haha CLI 启动脚本
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:$PATH"

cd "$SCRIPT_DIR"
exec ./bin/claude-haha "$@"
