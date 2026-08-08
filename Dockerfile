# ---- Builder stage ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
# npm workspaces（packages/*）——@pi-triple/infra 等 workspace 包链接必需
COPY packages/ ./packages/
RUN npm ci

COPY src/ ./src/
RUN npx tsc

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV DATA_DIR=/data

COPY package.json package-lock.json ./
# file: 依赖目标（@pi-triple/* workspace 包——npm ci 链接必需）
COPY packages/ ./packages/
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# PTL（packages/framework——仓库拆分后 pit.js 归属 framework 包）
COPY --from=builder /app/packages/framework/dist /app/packages/framework/dist

COPY config/ ./config/
# F/WP2 Task 8: supervisor.sh（A/B rebuild）从镜像移除（.rebuild-request 机制废弃，spec §3.4）；
# drain.sh 保留（优雅停机辅助）。
COPY scripts/drain.sh ./scripts/
RUN chmod +x scripts/*.sh

RUN mkdir -p /data/components /data/agent-dir /data/sessions /data/agent-lab /data/workspaces /data/platform /data/tenants && \
    chown -R node:node /data /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/pth/main.js"]
