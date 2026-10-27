#!/bin/bash
# Claude Buddy 启动脚本
#
# 关键：必须清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node 跑，
# 直接报 TypeError: Cannot read properties of undefined (reading 'whenReady')

cd "$(dirname "$0")" || exit 1
unset ELECTRON_RUN_AS_NODE

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 18+：https://nodejs.org/"
  read -r -p "按回车退出…"
  exit 1
fi

if [ ! -d "node_modules/electron" ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund || {
    echo "依赖安装失败，请检查网络。"
    read -r -p "按回车退出…"
    exit 1
  }
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "警告：PATH 里没找到 claude，应用会自行探测常见安装路径。"
  echo "       若仍失败，请安装：npm install -g @anthropic-ai/claude-code"
fi

exec ./node_modules/.bin/electron .
