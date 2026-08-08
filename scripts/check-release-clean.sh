#!/bin/bash
# 发行痕迹检查：npm pack --dry-run 输出中不得含用户痕迹关键词
# 用途：发行版不得保留用户使用痕迹（zlib 探索脚本 / bfc 编译器 / lifelab WIP /
#       ~/.pi-triple 数据 / docs/superpowers 个人记录 / .pi-platform-data /
#       extensions/agent-lab/.pi-subagents 运行痕迹 等）
# 只检查 npm pack 列出的【文件路径】，不检查文件内容——源码字符串引用不算命中。
# .pi-subagents：pi-subagents 工具运行痕迹（transcript.jsonl 含 ~/.pi-triple 绝对路径与完整对话历史），
#   已由 extensions/.gitignore 从打包中排除（根本修复）；此处关键词为第二道防线。
# transcript\.jsonl：只匹配痕迹工件名，不匹配合法的 transcript-store 源码文件名。
# Dockerfile\.dev|docker-compose|tools/dev|scripts/：dev 容器是私有研究环境（用户明确声明不进发行包），
#   与 bfc/lifelab 同级关键词加固——防未来 files 白名单改动把 dev 工具链带进发行包。
KEYWORDS="zlib|bfc|lifelab|pi-config|providers\.json|/sessions/|/workspaces/|\.pi-platform|superpowers|\.pi-triple|\.pi-subagents|transcript\.jsonl|Dockerfile\.dev|docker-compose|tools/dev|scripts/"
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
