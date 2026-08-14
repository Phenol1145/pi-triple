#!/bin/bash
# release-pack.sh —— v0.7.0 验证过的标准化发布打包（整仓库干净源码包）
#
# 背景（v0.7.0 发布事故复盘）：
#   - 误用 npm pack → 677KB 精简包（files 字段限制）——发布惯例是全仓库源码包
#   - v0.6.0 手动 tar 含 .pi-subagents（会话转录 120MB）/.pi-platform-data（生产数据）——
#     脏包绕过 npm pack 门禁
#   - 本脚本 = 唯一打包入口：排除清单 + 噪音自检（产出物内噪音计数必须为 0）
#
# 用法：
#   scripts/release-pack.sh            # 打包 pi-triple-v<version>.tgz + sha256
#   scripts/release-pack.sh --check   # 只检查（产出到 /tmp 后自检删除）——门禁集成用
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
OUT="pi-triple-v${VERSION}.tgz"

# 排除清单（v0.7.0 验证——对齐发布惯例；生产数据/会话痕迹/依赖/私有工具一律不进包）
EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='*.tgz'
  --exclude='.pi-subagents'
  --exclude='.worktrees'
  --exclude='.superpowers'
  --exclude='.DS_Store'
  --exclude='deploy/generated'
  --exclude='.pi-platform-data'
  --exclude='pi-triple-*'
)

# 噪音关键词（产出物路径命中即失败——发布物不得含任何用户痕迹/生产数据）
NOISE="\.pi-subagents|\.pi-platform-data|node_modules|\.worktrees|\.superpowers|transcript\.jsonl|/sessions/|/workspaces/"

if [ "${1:-}" = "--check" ]; then
  TMP_TGZ="$(mktemp /tmp/release-check-XXXX.tgz)"
  tar czf "$TMP_TGZ" "${EXCLUDES[@]}" . 2>/dev/null
  HITS=$(tar tzf "$TMP_TGZ" | grep -iE "$NOISE" | head -10 || true)
  rm -f "$TMP_TGZ"
  if [ -n "$HITS" ]; then
    echo "❌ 发布包含噪音（${VERSION}）:"
    echo "$HITS"
    exit 1
  fi
  echo "✅ 发布包干净（整仓库 tar 噪音检查——${VERSION}）"
  exit 0
fi

tar czf "$OUT" "${EXCLUDES[@]}" . 2>/dev/null

# 自检：产出物噪音必须为 0
HITS=$(tar tzf "$OUT" | grep -iE "$NOISE" | head -10 || true)
if [ -n "$HITS" ]; then
  echo "❌ 打包产物含噪音——拒绝发布:"
  echo "$HITS"
  rm -f "$OUT"
  exit 1
fi

SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ ${OUT}（${SIZE}）"
echo "sha256: $SHA"
