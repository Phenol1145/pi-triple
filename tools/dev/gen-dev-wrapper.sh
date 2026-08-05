#!/bin/bash
# gen-dev-wrapper.sh —— 生成本机 PTL 工具 wrapper（转发到 dev 容器）
# 用途：把迁入 dev 容器的开源工具在本机暴露同名命令，PTL 现有调用无感。
# 生成到 ~/.local/bin/（<tool> → docker compose exec dev <tool> "$@"）
#
# 用法：bash tools/dev/gen-dev-wrapper.sh            # 生成全部已迁工具
# 说明：非开源工具（kimiim-cli/obsidian 等 Mach-O）不生成 wrapper——保留本机。
# 依赖：docker compose 可用 + dev 容器已 build（docker compose up -d dev）

set -euo pipefail

COMPOSE="docker compose -f ${HOME}/pi-platform/docker-compose.yaml"
DEST="${HOME}/.local/bin"

# 已迁入 dev 容器的工具（与 Dockerfile.dev §7 对应——开源集）
TOOLS=(agent-reach yt-dlp instsci)

for tool in "${TOOLS[@]}"; do
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
echo "卸载：删除 ~/.local/bin/{agent-reach,yt-dlp,instsci} 即可"
