#!/bin/bash
# 双击这个文件即可启动 edgeMark，并自动用 Edge 打开。
# 终端窗口保持打开表示服务在运行；关掉终端（或按 Ctrl+C）即停止。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js（https://nodejs.org）后重试。"
  read -r -p "按回车键关闭…"
  exit 1
fi

if [ ! -d node_modules/markdown-it ]; then
  echo "首次运行，正在安装依赖…"
  npm install --no-audit --no-fund || {
    echo "依赖安装失败，请检查网络后重试。"
    read -r -p "按回车键关闭…"
    exit 1
  }
fi

exec node server/index.js --open
