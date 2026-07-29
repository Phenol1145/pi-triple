# Pi-Triple

基于 [pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的多租户 Agent 平台。双产品线：

| | PTL（Pi-Triple-Lite） | PTH（Pi-Triple-Heavy） |
|---|----------------------|------------------------|
| **定位** | 轻量开发/调试工具链 | agent 联邦平台 |
| **入口** | `pit` CLI | `pth` server（HTTP/SSE/WebSocket） |
| **运行时** | pi 进程 × tmux | AgentEngine + Redis + BullMQ |
| **适用** | 本地工作站 · 交互式调试 · 个人/小组 | 服务器部署 · 程序化 API · 集中治理 |
| **来源** | `src/ptl/` | `src/pth/` |
| **文档** | [PTL 架构](./docs/ptl/architecture.md) | [PTH 架构](./docs/pth/architecture.md) |

> **SDK 兼容性**：所有 pi SDK 调用通过 `src/shared/sdk-adapter/` 适配层隔离。升级 SDK 时只需修改适配层 + 跑测试，业务代码不受影响。当前适配 `@earendil-works/pi-coding-agent@^0.82.1`。

> 📐 **架构总览**：双产品全景、模块地图、数据流、硬约束见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)（单一真相源）。

## PTL 快速开始（推荐）

```bash
# 1. 全局安装
git clone <repo> && cd pi-platform
npm install && npm link

# 2. 导引（检查环境 + 安装提供商 + 创建租户 + 迁移扩展）
pit onboard

# 3. 创建模板（首次）
pit template new local

# 4. 启动
pit start                     # tmux 会话，立即接入
pit start --bg --name coding  # 后台启动
pit pi                        # 原生前台（无 tmux）

# 4. 控制面板
pit                            # pit ui TUI
pit lab                        # 模型调试 TUI
```

### pit CLI 命令速查

| 命令 | 说明 |
|------|------|
| `pit start` | 创建 tmux 会话并立即接入（默认；`--bg` 纯后台，`--name` 命名） |
| `pit pi` | 原生前台启动 pi（无 tmux，pi 原生体验） |
| `pit attach/switch/detach` | 接入 / 瞬移切换 / 脱离会话 |
| `pit ls / pit stop` | 列出 / 停止会话 |
| `pit ui` / `pit lab` | 系统控制 / 模型调试 TUI |
| `pit flow run/approve/reject/set/edit...` | pit-flow 波次工作流引擎 |
| `pit submit/run/dev/programs` | PTL→PTH 桥（agent 程序提交/运行） |
| `pit template ls/new/rm/rename` | 模板管理 |
| `pit config get/set/unset` | 配置读写 |
| `pit update --all` | 更新 pi + 扩展 + 内置同步 |
| `pit doctor` / `pit onboard` | 环境诊断 / 首次导引 |
| `pit install --shared <pkg>` | 安装共享扩展 |

详见 [PTL 架构](./docs/ptl/architecture.md)。

## PTH 服务器模式

```bash
# 安装依赖 + 启动 Redis
brew services start redis

# 启动平台
export ANTHROPIC_API_KEY=sk-ant-...
npm run pth:dev

# 测试
curl http://localhost:3000/health
```

```bash
# Docker 部署
docker-compose up -d
```

详见 [PTH 部署指南](./docs/pth/deployment.md) · [PTH API 参考](./docs/pth/api.md) · [PTH 架构文档](./docs/pth/architecture.md)。

## Roadmap

- [x] PTL：tmux 多会话管理 + pit ui/lab TUI
- [x] PTL：共享扩展层（symlink 注入，逐项更新）
- [x] PTL：pit-providers 统一 provider 后端（声明式 JSON + 多 Key failover）
- [x] PTL：pit-communicate 跨会话通信 + pit-control 会话内控制
- [x] **PTL：pit-flow 波次工作流引擎**（并行执行 + reducer + human gate + 运行中热修改）
- [x] **PTL→PTH 桥**：`pit submit/run` — agent 程序打包提交到 PTH 运行
- [ ] PTH：Windows 平台适配
- [ ] PTH：Dapr/K8s Phase 2 迁移

## 项目结构

> 完整模块说明见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

```
pi-platform/
├── src/
│   ├── shared/                    # 双产品共享（SDK 隔离层）
│   │   ├── sdk-adapter/           # pi SDK 唯一导入点
│   │   ├── model-router/          # 模型检测 + failover
│   │   ├── workspace/             # 工作目录隔离
│   │   ├── platform/              # 跨 OS 适配器（posix/win32）
│   │   └── observability/         # pino 日志
│   ├── ptl/                       # Pi-Triple-Lite（bin: pit）
│   │   ├── pit.ts + pit/          # CLI 入口 + 命令模块
│   │   ├── flow/                  # ★ pit-flow 波次工作流引擎
│   │   ├── bridge/                # ★ PTL→PTH 桥（submit/run/dev）
│   │   ├── lab-data/              # ★ lab 遥测数据层（SQLite）
│   │   ├── config.ts              # 配置系统（v2 UUID+alias）
│   │   ├── tmux.ts / launcher.ts  # tmux 会话 / pi 启动
│   │   ├── shared-layer.ts        # 共享扩展层（symlink+manifest）
│   │   ├── doctor.ts / migrate.ts # 诊断 / 迁移
│   │   ├── tui-pit/ + tui-lab/    # 双 Ink TUI
│   │   └── tui-shared/            # TUI 组件库 + Screen 布局
│   └── pth/                       # Pi-Triple-Heavy（bin: pth）
│       ├── main.ts                # 服务器入口
│       ├── core/                  # AgentEngine / SessionPool / Bridge
│       ├── gateway/               # Fastify（sessions/programs/self）+ SSE
│       ├── programs/              # ★ ProgramStore（桥的服务端）
│       ├── workflow/              # BullMQ 工作流编排
│       ├── tools/                 # 工具治理（allowlist+审计+指标）
│       ├── storage/               # Redis 存储层
│       ├── self-modify/           # 热加载 + A/B 重建
│       └── observability/         # Prometheus + 审计
├── extensions/                    # bundled 扩展（5 个）
│   ├── pit-providers/             # 统一 provider 后端
│   ├── pit-communicate/           # 跨会话通信
│   ├── pit-control/               # 会话内控制
│   ├── workflow/                  # ★ pi 内流程编排（/flow）
│   └── agent-lab/                 # 模型遥测
├── examples/                      # echo-agent / pr-review / arena-review / custom-*
├── test/                          # 447 个测试（vitest）
├── docs/
│   ├── pth/                       # api.md / architecture.md / deployment.md
│   └── ptl/                       # architecture.md
├── ARCHITECTURE.md                # ★ 架构总览（单一真相源）
├── Dockerfile
└── docker-compose.yaml
```

## 技术栈

| 组件 | 用于 | 用途 |
|------|------|------|
| Node.js >=22 | 全部 | 运行时 |
| TypeScript 5.7 | 全部 | 类型安全 |
| pi SDK 0.82 | 全部 | Agent 执行引擎 |
| React + Ink | PTL | TUI 渲染 |
| tmux | PTL | 会话管理 |
| Fastify 5.x | PTH | HTTP 网关 |
| ioredis 5.x | PTH | Redis 客户端 |
| bullmq 5.x | PTH | 工作流任务队列 |
| pino 9.x | PTH | 结构化日志 |
| prom-client 15.x | PTH | Prometheus 指标 |
| vitest 3.x | 全部 | 测试框架 |

## 开发者指南

### 快速循环

```bash
npx tsc --noEmit        # 类型检查（不产出 dist）
npx vitest run           # 447 tests（直跑 TS）
npm run build && npm link # ★ pit/pth bin 跑 dist/，端到端验证前必须 build
cd /tmp && pit template ls  # 冒烟测试
```

> ⚠️ `tsc --noEmit` 与 vitest 都不产出/不依赖 dist，会掩盖“改了 src 未重建”的问题；CLI 冒烟前务必 `npm run build`。

### 扩展开发

| 想做什么 | 参考 |
|----------|------|
| 新建 pi 扩展（bundled） | `extensions/pit-providers/` — provider 注册 |
| 扩展命令 + 参数补全 | `extensions/pit-control/index.ts` — registerCommand + getArgumentCompletions |
| 跨会话通信 | `extensions/pit-communicate/` — 文件邮箱 + Delivery 决策 |
| PTH 自定义工具/路由/存储 | `src/pth/` — 接口替换见 [PTH 架构 #扩展方式](./docs/pth/architecture.md) |
| PTL 加 CLI 命令 | `src/ptl/pit/admin.ts` + 注册到 `src/ptl/pit.ts` switch |
| TUI 新页面 | 遵循 [Screen 布局模板](./src/ptl/tui-shared/README.md) 5 条规则 |

### 设计原则

| 原则 | 说明 |
|------|------|
| pi 是引擎 | 不重写 pi 能力，做的是外层治理/编排/体验 |
| 模板隔离 | PTL：独立 pi 进程 + `PI_TEMPLATE`/`PI_CODING_AGENT_DIR`；PTH：Engine 层强制校验 |
| 错误用判别联合 | `Result<T> = {ok:true, data} \| {ok:false, error}` |
| 终端切换协议 | `unmountInk()` → `stdin.pause()` → `spawnSync(stdio: "inherit")` → `process.exit(status)` |
| 零外部依赖（扩展） | bundled 扩展只用 `node:` 内置 + 相对导入 |

## 已知限制

- **PTL 无 HTTP API**：适合本地工作站交互，不适合程序化/远程访问（→ PTH）
- **PTH 无 TUI**：适合服务器/API 场景（→ PTL 本地调试 + PTL→PTH 桥）
- **tmux**：Unix-only（Windows 支持规划中）
- **PTH 进程限制**：BullMQ worker 在主进程（Phase 1 技术债）
- **pit-communicate**：单机通信，不支持跨机器

## License

MIT
