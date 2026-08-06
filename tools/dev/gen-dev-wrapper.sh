#!/bin/bash
# gen-dev-wrapper.sh —— 生成本机 PTL 工具 wrapper（转发到 dev 容器）
# 用途：把迁入 dev 容器的工具在本机暴露同名命令，PTL 现有调用无感。
# 生成到 ~/.local/bin/（<tool> → docker compose exec dev <tool> "$@"）
#
# 用法：
#   bash tools/dev/gen-dev-wrapper.sh                 # 生成全部默认工具（TOOLS 数组）
#   bash tools/dev/gen-dev-wrapper.sh <tool> [...]    # 只生成指定工具的 wrapper
# 说明：非开源工具（kimiim-cli/obsidian 等 Mach-O）不生成 wrapper——保留本机。
# 依赖：docker compose 可用 + dev 容器已 build（docker compose up -d dev）

set -euo pipefail

DEST="${HOME}/.local/bin"

# 默认工具集（与 Dockerfile.dev §7 对应——开源集）；传参时以参数为准
TOOLS=(${@:-agent-reach yt-dlp instsci chatgpt-share})

for tool in "${TOOLS[@]}"; do
  # 目标是符号链接时 cat > 会穿透写坏链接目标（如指向工具源码）——先移除
  if [ -L "${DEST}/${tool}" ]; then
    echo "! ${DEST}/${tool} 是符号链接，先移除（防写入穿透）"
    rm "${DEST}/${tool}"
  fi
  cat > "${DEST}/${tool}" <<EOF
#!/bin/bash
# dev 容器工具 wrapper（生成于 $(date +%F)）——实际执行在 dev 容器内
exec docker compose -f ${HOME}/pi-platform/docker-compose.yaml exec -T dev ${tool} "\$@"
EOF
  chmod +x "${DEST}/${tool}"
  echo "✓ ${DEST}/${tool} → dev:${tool}"
done

echo ""
echo "提示：若 dev 容器未启动，wrapper 会报错——先 docker compose up -d dev"
echo "卸载：删除 ~/.local/bin/{${TOOLS[*]}} 即可"
