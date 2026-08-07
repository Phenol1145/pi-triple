# Scout-9：extensions/ 深度侦察（除 agent-lab）+ 根 ARCHITECTURE.md 全文要点

日期：2026-08-07 · Scout 9 of structure recon
范围：(A) extensions/ 下 agent-lab 之外全部 6 个条目 + _shared；(B) 根 `ARCHITECTURE.md`（272 行，已全文通读）要点与偏离。

---

## (A) 扩展清单表

加载方图例：**PTL-symlink** = 经 `~/.pi-triple/data/shared/extensions/` 由 `src/ptl/shared-layer.ts` 逐项 symlink 注入每个模板 `pi-config/<uuid>/extensions/`（pi 扩展加载器按 package.json `pi.extensions` 或目录内 index 加载）；**PTH-dynimport** = `src/pth/main.ts` 动态 import 注入常驻系统会话。

| 扩展 | 一行职责 | 形态 | 加载方 | 状态 | 最后改动 |
|---|---|---|---|---|---|
| **agent-lab** | agent 经济引擎：WorkLoop 状态机 + 市场竞拍 + 调度器 + 优化器 + 实验运行时 + 任务池（详见 scout-2/agent-lab 自身 ARCHITECTURE.md） | default async factory（`extensions/agent-lab/index.ts:79`） | **PTL-symlink** + **PTH-dynimport**（`src/pth/main.ts:96-110`，注入常驻系统会话 extensionFactories，fail-open） | **活跃（持续增长）** | 2026-08-07（任务池域、stale_reclaim 等） |
| **agent-lab-bidder** | `place_bid` 工具：把 subagent 出价写入 `getBidBoard()`（globalThis 单例） | default factory（`index.ts:16`），package.json 带 `pi.extensions` | PTL-symlink 仅 | **兼容垫片 / deprecated-for-bidding**（ADR-0001 后竞价走 market-bid-loop WorkLoop + ModelPort 原生出价，代码保留不删以免破坏已部署加载） | 2026-08-01（schema 扁平化修复） |
| **pit-communicate** | 跨 pi 会话通信：文件邮箱 `/pit send/ask/inbox/share` + manual/auto/hybrid 审核 + 不可变审计日志 | default factory `pitMail`（`index.ts:115`），`main: index.ts` | PTL-symlink 仅 | **稳定期（特性冻结，仅 session_start 更新提示等小改）**；但**记忆 spec 的桥接依赖未落地**（见 §关系） | 2026-08-01 |
| **pit-control** | 会话内管理 tmux 后台 pi 会话：`/control start/stop/ls/switch/detach/ui/name/status` | default factory `pitControl`（`index.ts:23`） | PTL-symlink 仅 | 稳定（08-01 与 pit-communicate 整合重构后冻结） | 2026-08-01 |
| **pit-providers** | 统一 provider 后端：声明式 `providers.json` + 多 Key 池 + 401/403 failover + `/keys` 管理 + 动态 refreshModels | default factory `pitProviders`（`index.ts:428`） | PTL-symlink 仅 | **活跃单点**（hook 类，唯一一次提交 2026-07-29；含双注册防护检测旧 kimi-platform/ustc-llm） | 2026-07-29 |
| **workflow** | pi 会话内 pit-flow 接口：`/flow` 命令 + `flow_run/flow_status/flow_ls` 工具 + human-gate 通知 | default factory（`index.ts:92`） | PTL-symlink 仅 | 活跃（依赖 `pit flow` CLI，runner.ts 全部 shell 外调，零进程内逻辑） | 2026-08-01 |
| **_shared/** | **非扩展**（注释明示"勿加 index.ts"）：paths/presence/registry/tmux-session/version-check 五个共享模块 | 无 index.ts 无 package.json | 随 symlink 进入模板目录但**不被 pi 加载** | 供 pit-communicate / pit-control 共用（08-01 整合时从 communicate 迁出） | 2026-08-01 |

### 精确引用

- 打包为 bundled 的 6 个目录：`/Users/anzhize/pi-platform/extensions/`（agent-lab、agent-lab-bidder、pit-communicate、pit-control、pit-providers、workflow；`_shared` 不算第 7 个）。
- 加载机制（`src/ptl/shared-layer.ts`）：
  - `resolveBundledDir` (L15-42) 从模块位置逐级探测仓库/extensions；
  - `installBundledExtensions` (L180-209) 首次安装复制到共享层（已存在跳过）；
  - `syncBundledExtensions` (L212-276) `pit update --all` 覆盖式同步 + `.bundled-manifest` 剪枝（调用点 `src/ptl/pit/admin.ts:196-199`）；
  - `linkTemplateToShared` (L45-73) 逐项 symlink 注入模板，`ensureTemplateLinks` 每次启动补链（删 symlink 会复活）。
- 实装证据：`~/.pi-triple/data/pi-config/<uuid>/extensions/` 下 6 个 bundled + `.bundled-manifest` + `_shared` 均为 symlink → `../../../shared/extensions/...`（已抽查 3 个模板，一致）。
- PTH 侧唯一加载 agent-lab：`src/pth/main.ts:96-110`（非字面量 import specifier `"../../extensions/agent-lab/index.ts"`，TS5097 规避；失败放行 fail-open）。

### 与 agent-lab 的关系

| 扩展 | 与 agent-lab 的关系 | 代码证据 |
|---|---|---|
| **agent-lab-bidder** | **强耦合**：直接相对 import `../agent-lab/src/arena/bid-board.ts`，与 agent-lab 的 market scheduler 共享同一 globalThis BidBoard 单例；token 由 scheduler 生成下发 | `extensions/agent-lab-bidder/index.ts:15,19`；`extensions/agent-lab/src/arena/bid-board.ts:5-9` 注释确认跨扩展共享实例。依赖双方同为 symlink 进同一 `extensions/` 目录才可解析（平台布局强约束） |
| **pit-communicate** | **spec 层依赖，代码层未接线**：记忆系统 spec 计划 C "传输复用 pit-communicate + 语义桥接"（`docs/superpowers/specs/2026-08-02-memory-system-design.md:182,223`）；agent-lab 的 `CommsBridge`（`extensions/agent-lab/src/assembly/comms-bridge.ts`）实现了契约⑥⑨⑩ 但**自带 inbox.jsonl + IdentityMap**，不 import pit-communicate；`CommsTransport` 接口（`extensions/agent-lab/src/memory/comms.ts:39-43`）**无生产实现**（scout-4 已确认仅测试 mock）→ "Task 12 pit-communicate 接线"未落地 | comms-bridge.ts:41,132 注释反复出现 "pit-communicate session_start 时接线"（未来时） |
| **pit-control** | 无直接依赖；与 pit-communicate 共享 `_shared` 模块（08-01 consolidation，plan `docs/superpowers/plans/2026-08-01-pit-communicate-control-consolidation.md`） | `extensions/pit-control/index.ts:13-16` |
| **pit-providers** | 无依赖；仅防护性检测 legacy 扩展存在 | `index.ts:31-48` |
| **workflow** | 无依赖；与 PTH 的 `src/pth/workflow/`（BullMQ 编排）**同名但完全独立**（本地 pit-flow 接口 vs 服务器编排） | runner.ts 全部外调 `pit flow` CLI |

### "extension 退场为代码库"背景下的现状判定

上下文来源：`docs/superpowers/specs/2026-08-06-cli-template-migration-design.md`（P1-P4 路线图，P3 默认路线 (b) CLI 后端适配壳 + parity 门槛）与 `docs/superpowers/explorations/2026-08-07-vm-kernel-draft.md`（未定稿：extension 退场为"代码库里的可复用 TS 片段"，vm 内核统一解释）。

- **现状：迁移尚未开始**——6 个 bundled 扩展全部仍在打包、仍逐模板 symlink 注入；`pit update --all` 覆盖同步照常运行。P1（cli-dev 试点 + 排除机制 + local→root 更名）进行中，P3 逐扩展迁移未动。
- 分类归属（按 CLI 迁移 spec §1 表格）：
  - 工具类：**agent-lab-bidder (place_bid)** → (b) 适配壳候选；
  - 命令/UI 类：**pit-control (/control)**、**workflow (/flow)** → `pit CLI --json` 候选；
  - 进程内 hook 类：**pit-providers**（after_provider_response 401/403）→ localhost provider proxy 专项或**永久留 root**；
  - 实时推送/遥测类：**pit-communicate**（投递）、agent-lab（遥测注入）→ 轮询 CLI / sidecar，接受延迟降级。
- 与 vm-kernel-draft 的一致性：draft L26 明确"与结构审计发现的 CLI 化迁移路线方向一致"，但精确形态未定稿（draft L48）。
- 特别风险：**agent-lab-bidder 的相对 import**（`../agent-lab/src/...`）是"退场为代码库"时最先断裂的耦合点——若 agent-lab 迁出扩展目录，bidder 的 import 必须同步改造；且按 vm-kernel 设想两者都应变为代码片段。

---

## (B) 根 ARCHITECTURE.md（272 行）要点

### 1. 双产品全景 / 数据流 / 硬约束

- **单仓双产品**：PTL（`pit` CLI，`dist/ptl/pit.js`，真实 pi × tmux，本地 TUI）与 PTH（`pth` server，`dist/pth/main.js`，AgentEngine + Redis + BullMQ，HTTP/SSE/WebSocket，联邦治理）。共享 `src/shared/`（sdk-adapter / model-router / workspace / platform / observability / credential-provider）。**PTL→PTH 桥**：`pit hub submit/run`（L28-42 图）。
- **数据流 A**（hub submit）：pack.ts 读 agent.json + skills → 手写 ustar.ts 打 tar → POST /api/v1/programs → ProgramStore（INCR 版本 + 安全解包）→ `pit hub run` 起一次性 session → SSE 双信封 {seq,type,data} 流式回显。
- **数据流 B**（pit-flow 波次）：createRun → execLock → 波循环（findReadyNodes by firedEpoch/consumed）→ 同波并行 spawn pi → 波末 reducer 合并 + checkpoint → human gate / edit 屏障。
- **硬约束**（L216-230）：SDK 隔离（仅 `src/shared/sdk-adapter/` 可 import pi SDK）、C1（JSON DTO + AsyncIterable 不共享引用）、C5（服务端推导工作目录）、C7（Engine 层校验 tenantId）、C8（ToolPlatform 不重写内置工具）、PTL 零依赖（手写 ustar/expr/fs.watch）、原子写（tmp+rename）、tmux `-e KEY=VAL` 禁 shell 拼接。
- 数据布局：PTL `~/.pi-triple/`（pi-triple.json / providers.json / data/{pi-config,sessions,workspaces,shared,mailbox,flows}）；PTH `{DATA_DIR}`（workspaces/platform/programs/tenants + Redis key 模式）。
- 技术栈：Node ≥22 · TS 5.7 · pi SDK 0.82 · Ink TUI · tmux · Fastify 5 + ioredis 5 + bullmq 5 · SQLite WAL · vitest 614 root + node:test 1288 agent-lab。

### 2. 文档 vs 实际代码的偏离

| # | 文档表述 | 实际代码 | 严重度 |
|---|---|---|---|
| D1 | PTH "WorkflowOrchestrator：服务端 **BullMQ** 工作流（parallel/condition 为 stub）"（L164-166） | BullMQ 仅用于 intent worker（`src/pth/workflow/bullmq-worker.ts` 真 Worker）；**执行本身是进程内同步 for 循环 + Redis fencing lock**（`orchestrator.ts:24-56`）。parallel 是顺序嵌套（`orchestrator.ts:98-106`，忽略 `concurrency`/`failStrategy`）、condition 完全忽略 `predicate` 恒走 then（L108-110）、human-approval 停等。比文档更 stub | 中（描述夸大 BullMQ 角色） |
| D2 | 扩展生态描述为"6 个 bundled，共享层 symlink 注入"（L148-158） | 对，但**漏了 PTH 侧也加载 agent-lab**（`src/pth/main.ts:96-110` 动态 import 注入系统会话）——文档把扩展完全框定为 PTL 机制 | 低-中（PTH 部署文档偏差） |
| D3 | agent-lab 一行描述为"agent 经济引擎 … 任务池/优化器"（L156） | 与代码一致（根文档较新）；但 **`docs/ptl/architecture.md:193-208` 仍把 agent-lab 描述为"模型遥测"**——分产品文档过时（与根文档冲突） | 低（内档不一致） |
| D4 | 测试数 614 + 1288（L240） | 未验证；agent-lab 子套件在持续扩（08-07 仍有新集成测试） | 低 |
| D5 | 未提 vm 内核/extension 退场 | 属超新方向（08-07 draft 未定稿），根文档未收录属正常 | 信息 |

### 3. 是否提到 agent-lab / 记忆系统 / 任务池 / vm 内核

- **agent-lab**：✅ 扩展表一行 + 指向 `extensions/agent-lab/docs/ARCHITECTURE.md`（L155-157）。
- **记忆系统（memory system）**：❌ 根文档**未提及**。记忆系统只存在于 agent-lab 自身 docs + `docs/superpowers/specs/2026-08-02-memory-system-design.md`；根文档仅提 PTL 侧 "lab-data 遥测"（`src/ptl/lab-data/`，另一回事）。
- **任务池（task pool）**：❌ 未提及。任务池域是 08-07 才进入 agent-lab（`extensions/agent-lab/src/task-pool/`，commit 1da5f42/9d39a6e），根文档早于该域定稿。
- **vm 内核**：❌ 未提及（`docs/superpowers/explorations/2026-08-07-vm-kernel-draft.md` 未定稿，属探索文档）。

---

## 给下一位 agent 的入口

1. 改扩展机制：`src/ptl/shared-layer.ts`（唯一真相）；`pit update --all` 触发点在 `src/ptl/pit/admin.ts:196-199`。
2. 审 pit-communicate 桥接缺口：`extensions/agent-lab/src/memory/comms.ts:39-43`（CommsTransport 无生产实现）→ `extensions/agent-lab/src/assembly/comms-bridge.ts`（自带 inbox，不依赖 pit-communicate）。
3. 做 P3 迁移清单：CLI 迁移 spec §1 分类表 + 本文扩展清单表，逐项对照。
