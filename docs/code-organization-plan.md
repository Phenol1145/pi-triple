# 代码整理规划（运行时分类：deps / host / container / config + dual）

> 状态：**规划阶段，未物理移动任何目录**。本文是把整个项目分解为
> 依赖（deps）/ 宿主机执行（host）/ 容器内执行（container）/ 设置（config），
> 并为“双栖模块”预留独立区（dual）的分类契约。
> 机器清单见 [docs-manifest.json](./docs-manifest.json) 的 `codeRuntime`。

## 1. 分类规则

| 类别 | 判据 | 当前归属 |
|------|------|----------|
| `deps` | 被加载使用的库/基础包，不是独立进程入口 | `packages/shared` · `infra` · `pth-memory` · `mailbox` |
| `host` | 入口/命令只在宿主机运行 | `packages/framework` · `scripts/` · `packages/dev-container` |
| `container` | 只在容器内作为服务/数据面运行 | `packages/pth-sandbox` · `toolstore/` · `extensions/` · Dockerfile |
| `dual` | 同一模块有宿主机与容器两种运行形态 | `src/pth/` · `packages/pth-console/` · `deploy/docker-monitor/` |
| `config` | 拓扑/密钥/lock/构建配置 | `deploy/docker-compose*.yaml` · `deploy/*.json` · `deploy/.env.pth.secrets*` · `config/` · `tsconfig*/package.json` |

**双栖规则（已定）**：不拆包、不硬归 host 或 container；后续物理整理时单独放进
`dual/`（或等价目录），并用清单标注“主运行形态 + 次形态”。避免同一份代码出现两份实现。

## 2. 现状 → 目标映射（不搬家，只标注）

| 当前路径 | 类别 | 主运行形态 | 备注 |
|----------|------|-----------|------|
| `packages/shared/` | deps | — | 配置/路径/版本，PTL/PTH 共用 |
| `packages/infra/` | deps | — | model router/log/platform/sdk/container-runtime |
| `packages/pth-memory/` | deps | — | PTH 记忆库（进程内） |
| `packages/mailbox/` | deps | — | 跨会话邮箱 |
| `packages/framework/` | host | 宿主机 | PTL CLI/TUI/容器运维命令 |
| `scripts/` | host | 宿主机 | pth CLI 入口/验收/维护脚本 |
| `packages/dev-container/` | host | 宿主机 | 控制 dev 容器 |
| `src/pth/` | dual | 容器（生产） | 宿主机 `node dist/pth/main.js`/tsx dev |
| `packages/pth-console/` | dual | 宿主机 | CLI/loopback Web；server 可随部署进容器 |
| `deploy/docker-monitor/` | dual | 宿主机 | MONITOR_HOST 直跑；也可入容器采集 |
| `packages/pth-sandbox/` | container | 容器 | kernel 池 + exec API |
| `toolstore/` · `extensions/` | container | 容器 | PTH 扩展/策略/编译单元 |
| `deploy/Dockerfile*` | container | 构建 | 主服务/sandbox/dev/jupyter 镜像 |
| `deploy/docker-compose*.yaml` | config | — | compose 拓扑 |
| `deploy/*.json` | config | — | runtime lock/部署描述 |
| `deploy/.env.pth.secrets*` | config | — | secrets（gitignore）+ example |
| `config/` | config | — | pi 模板/配置面 |
| `tsconfig*.json` / `package.json` / lock | config | — | workspace/构建配置 |

## 3. 后续物理搬迁步骤（需另行批准，每步一 lane）

1. 保持 `packages/*` workspace 不变，先完成文档清单（本文件 + `docs-manifest.json`）；
2. 若用户确认搬家：
   - 新建 `dual/` 收纳 `src/pth`、`packages/pth-console`、`deploy/docker-monitor`（或保留各自目录、仅登记清单——二选一）；
   - `host/` 收纳 framework/scripts/dev-container；`container/` 收纳 pth-sandbox/toolstore/extensions；
   - `config/` 汇总 compose/secrets/lock（注意：`deploy/` 的镜像构建路径与 compose context 必须同步更新）；
   - 每步跑 `npm run check:docs-links` + lint/build/full，保证链接与产品边界零回退。
3. 不搬的内容：`test/`、`docs/` 与 `.worktrees/`（测试与文档按各自清单治理，不混入运行时分类）。

## 4. 边界约束

- 分类是**运行时位置**维度，与 **PTL/PTH 产品边界**（`docs/pth/module-ownership.md`）正交；搬目录不得改变 import 方向。
- `deps` 不允许反向 import `host/container`；`dual` 模块的两种形态共享同一实现。
- 每次迁移先更新 `docs-manifest.json` 的 `codeRuntime`，再动目录。
