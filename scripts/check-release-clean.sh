#!/bin/bash
# 发行痕迹检查：npm pack --dry-run 输出中不得含用户痕迹关键词
# 用途：发行版不得保留用户使用痕迹（zlib 探索脚本 / bfc 编译器 / lifelab WIP /
#       ~/.pi-triple 数据 / docs/superpowers 个人记录 / .pi-platform-data 等）
# 只检查 npm pack 列出的【文件路径】，不检查文件内容——源码字符串引用不算命中。
KEYWORDS="zlib|bfc|lifelab|pi-config|providers\.json|/sessions/|/workspaces/|\.pi-platform|superpowers|\.pi-triple"
OUT=$(npm pack --dry-run 2>&1)
if [ -z "$OUT" ]; then
  echo "❌ npm pack --dry-run 无输出（命令失败？）"
  exit 1
fi
HITS=$(echo "$OUT" | grep -iE "$KEYWORDS" | grep -v "node_modules" | head -20)
if [ -n "$HITS" ]; then
  echo "❌ 发行包含用户痕迹:"
  echo "$HITS"
  exit 1
fi
echo "✅ 发行包干净（无用户痕迹）"
echo "文件数: $(echo "$OUT" | grep -c 'notice.*B ')"
