# pi-platform

基于 [pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的多租户 Agent 平台。模块化单体架构，设计目标为内部团队使用的编码 Agent 服务，单机部署，后续可拆分迁移至 Dapr/K8s。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                       Clients                           │
│         HTTP/SSE  │  WebSocket  │  CLI (in-process)     │
├──────────────────────────┬──────────────────────────────┤
│            Gateway        │                              │
│    Fastify + auth hook    │                              │
├──────────────────────────┼──────────────────────────────┤
│       Agent Engine        │        Workflow              │
│   Session Pool (busy/     │   Orchestrator (state        │
│   idle state machine)     │   machine + BullMQ intents)  │
├──────────────────────────┼──────────────────────────────┤
│                        pi SDK                           │
│       createAgentSession() · ModelRuntime               │
├───────────┬──────────┬──────────┬──────────┬───────────┤
│  Model    │  Tool    │Workspace │  Self-   │  Storage   │
│  Router   │ Platform │ Manager  │  Modify  │  DAL (Redis│
│           │ (C8:     │          │ (L1/L2/  │  append-   │
│           │ adapt)   │          │  L3)     │  only)     │
├───────────┴──────────┴──────────┴──────────┴───────────┤
│                 Infrastructure                           │
│  Redis · BullMQ · pino · prom-client · chokidar          │
└─────────────────────────────────────────────────────────┘
```

## 快速开始

### 本地运行

```bash
# 1. 安装依赖
git clone <repo> && cd pi-platform
npm install

# 2. 启动 Redis
brew services start redis          # macOS
# 或: redis-server --daemonize yes

# 3. 设置 API key（至少一个）
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# 4. 启动平台
npm run dev

# 5. 创建 token 并测试
redis-cli SET "auth:token:test-token" '{"tenantId":"demo","createdAt":1700000000}'

curl -s -X POST http://localhost:3000/api/v1/sessions \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{"project":"hello"}'
```

### Docker 部署

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker-compose up -d
curl http://localhost:3000/health
```

### CLI 模式（无 HTTP）

```bash
npm run cli
# 进入 REPL：直接输入对话，/help 查看更多命令
```

## 项目结构

```
pi-platform/
├── src/
│   ├── main.ts                    # 入口：组装所有模块
│   ├── cli.ts                     # CLI REPL（直接使用 AgentEngine）
│   ├── platform/                  # 跨 OS 适配器（POSIX / Win32）
│   ├── observability/             # pino 日志、Prometheus 指标、审计
│   ├── storage/                   # Redis 存储层（session/entry/snapshot/settings）
│   ├── workspace/                 # 工作目录管理（租户隔离、按项目创建）
│   ├── model-router/              # 模型自动检测 + failover
│   ├── tools/                     # 工具治理平台（allowlist + 审计 + 指标）
│   ├── core/                      # AgentEngine / SessionPool / Bridge
│   ├── gateway/                   # Fastify HTTP + WebSocket
│   ├── workflow/                  # BullMQ 工作流编排
│   └── self-modify/               # 热加载 + A/B 重建触发器
├── test/                          # 58 个测试（单元 36 + 集成 22）
├── config/                        # settings.json / SYSTEM.md
├── scripts/supervisor.sh          # A/B 启动 + 健康检查 + 回滚
├── Dockerfile
└── docker-compose.yaml
```

## 技术栈

| 组件 | 版本 | 用途 |
|------|------|------|
| Node.js | >=22 | 运行时 |
| TypeScript | 5.7 | 类型安全 |
| Fastify | 5.x | HTTP 网关 |
| @fastify/websocket | 11.x | WebSocket |
| ioredis | 5.x | Redis 客户端 |
| bullmq | 5.x | 工作流任务队列 |
| pi SDK | 0.82 | Agent 执行引擎 |
| pino | 9.x | 结构化日志 |
| prom-client | 15.x | Prometheus 指标 |
| chokidar | 4.x | 文件热加载 |
| vitest | 3.x | 测试框架 |

## 硬约束

| ID | 约束 | 落实 |
|----|------|------|
| C1 | 跨模块 JSON DTO，流式 AsyncIterable | ✅ Result 判别联合 + SSE AsyncIterable |
| C2 | 无 OS 沙箱，仅 cwd 隔离 | ✅ WorkspaceManager 按租户创建目录 |
| C3 | BullMQ 仅处理无状态短任务 | ✅ 编排状态机在 App 层 |
| C4 | BullMQ worker 在 worker_threads | ⚠️ 主进程降级（Phase 1 技术债） |
| C5 | Token→租户，路径服务端推导 | ✅ auth hook + 服务端 cwd 生成 |
| C6 | pino + Prometheus | ✅ tokensTotal / toolCallsTotal / sessionsActive |
| C7 | Engine 层租户校验 | ✅ prompt/abort/destroy 全员校验 |
| C8 | 工具适配器模式，不重写 pi 工具 | ✅ ToolPlatform 是治理层 |
| C9 | Turn 级版本快照 | ✅ computeHash + saveSnapshot |
| C10 | 外部 supervisor 回滚 | ✅ supervisor.sh（Docker 入口待接线） |

## 开发者指南

### 开发循环

```bash
# 1. 修改代码
vim src/tools/custom/my-tool.ts

# 2. 类型检查
npx tsc --noEmit

# 3. 跑测试
npx vitest run

# 4. CLI 快速验证
npm run cli

# 5. HTTP 验证（需先启动服务）
npm run dev &
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Authorization: Bearer test-token" \
  -d '{"project":"dev-test"}'

# 6. 提交
git add -A && git commit -m "feat: ..."
```

### 扩展点速查

| 想做什么 | 去哪里 | 参考 |
|----------|--------|------|
| 添加自定义工具 | `src/tools/` | [architecture.md #ToolPlatform](./docs/architecture.md#toolplatformc8-治理层) |
| 添加 API 端点 | `src/gateway/` | [architecture.md #Gateway](./docs/architecture.md#gateway-layer) |
| 替换存储后端 | `src/storage/` | [architecture.md #存储模型](./docs/architecture.md#存储模型) |
| 定义工作流 | `src/workflow/` | [architecture.md #WorkflowOrchestrator](./docs/architecture.md#workfloworchestrator) |
| 添加 Skill/Prompt | `{DATA_DIR}/platform/` | [architecture.md #Self-Modify](./docs/architecture.md#self-modify自修改) |
| 添加模型凭证来源 | `src/storage/credential-provider.ts` | 实现 `CredentialProvider` 接口 |

### 示例代码

见 `examples/` 目录，每个示例可直接运行：

```bash
npx tsx examples/custom-tool/index.ts    # 自定义工具
npx tsx examples/custom-route/index.ts   # 自定义 API 端点
npx tsx examples/custom-store/index.ts   # 自定义存储后端
```

### 设计原则（必读）

| 原则 | 说明 |
|------|------|
| DTO 纪律 | 跨模块只传 JSON 可序列化对象，不传 class 实例 |
| 流式用 AsyncIterable | 不用 callback / EventEmitter，通过 Bridge 桥接 |
| 错误用判别联合 | `Result<T> = {ok:true, data} \| {ok:false, error}` |
| 租户隔离 | 所有数据操作带 tenantId，Engine 层强制校验 |
| 工具是治理层 | 不重写 pi 内置工具，只包装审计/ACL/指标 |

详见 [architecture.md #硬约束详解](./docs/architecture.md#硬约束详解)。

## 已知限制

- **worker_threads**（C4）：BullMQ worker 在主进程运行，生产环境建议隔离
- **恢复**：`recoverAll()` 为骨架（崩溃后 session 不自动恢复）
- **工作流**：`parallel` / `condition` 步骤为 stub
- **工具批准**：`requiresApproval` 定义存在但审批流程未实现
- **Docker compose** 中 Redis `maxmemory-policy allkeys-lru` 可能导致 session token 意外淘汰，生产环境建议改为 `noeviction` 或 `volatile-lru`

## License

MIT
