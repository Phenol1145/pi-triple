# 框架 vs 构造：代码归属划分（agent-lab）

> **目的**：分清哪些代码是**可复用的运行时框架**（场景无关、注入驱动），哪些是**构造具体联邦/实验**（绑定场景）。
> 这是子项目 E（联邦引导 Bootstrap）与 F（容器化）的前提——E/F 只动构造层 + 框架的启动入口，不动框架机制。
>
> **裁决（2026-08-05 用户确认）**：economy 域 = **框架**（通用市场经济引擎）；Bootstrap = **用框架拼装 + 种子数据**；"一个联邦"的边界待定义。

## 三层结构

```
┌────────────────────────────────────────────────────────────┐
│ 构造层（搭建具体联邦 / 实验 / 冒烟）—— 绑定场景，含硬编码     │
├────────────────────────────────────────────────────────────┤
│ 框架层（可复用运行时引擎）—— 场景无关，依赖注入驱动          │
├────────────────────────────────────────────────────────────┤
│ 平台层（接入 / 服务）—— ptl CLI / pth HTTP / pit-* 扩展      │
└────────────────────────────────────────────────────────────┘
```

**判断标准**：一份代码是否**绑定具体场景**（特定任务、特定 agent 集、特定种子数据、特定实验）。
- 场景无关、行为由**注入的依赖/参数**决定 → 框架。
- 含**具体任务/agent/种子/实验数据**，或为搭建某个具体系统而写 → 构造。

---

## 框架层（可复用引擎——E/F 复用，不动机制）

| 域 | 内容 | 为何是框架 |
|---|---|---|
| `core/` | LabCore/contracts/storage/control-plane/definitions/tx-utils/agent-spec | 核心契约与存储抽象，零场景 |
| `arena/` | ledger（账本）/bid-board/policies/types/agent-id/model-caller | 经济账本基座（被 economy 复用），通用 |
| `economy/` | market-runner/market-fns/market-effects/settlement/escrow/central-pool/elo/voucher-port/calibration/org/review-round/projections/experience/economy-events/task-types/market-store/tx-utils | **通用市场经济引擎**——`grep` 实证零构造痕迹（无具体任务/agent 硬编码）；RESERVED_IDS（central-pool/calibration-executor——**operator 不在其中**，仅为普通 agent）是机制常量非场景 |
| `memory/` | entry/pipeline/dsp/ebnf/rules/store/watermark/public-domain/comms/audit-chain/dialects/sdk | L3 语义记忆引擎，通用 |
| `assembly/` | assembler/agent-runtime/memory-host/ledger-port/comms-bridge/public-bootstrap/rule-bootstrap | Agent 装配引擎（fresh/fork），通用 |
| `workloop/` | runner/machine/contracts/checkpoints/state-store/registry/instrumented-model-port/context/machine-runtime | 执行循环框架（契约/引擎） |
| `scheduler/` | runner/registry/contracts/runner-sdk/names | 调度框架（契约/引擎） |
| `optimizer/` | contracts/registry/facade/shadow/auto-flow/canary-eval/context-projector/data-api/auto-trigger | 优化框架（契约/引擎） |
| `runtime/` | create-runtime/create-scheduler-runtime/create-experiment-runtime/delegation-v2/pi-subagents-adapter | **运行时工厂**（create-* 组装核心，注入驱动） |
| `scorer/` `catalog/` `telemetry/` `interceptor/` `store/` `config*.ts` `types.ts` | 评分/模型目录/遥测/拦截器/runs 存储/配置 | 通用支撑 |

## 构造层（搭建具体联邦/实验——E/F 在这层工作）

| 位置 | 内容 | 绑定的场景 |
|---|---|---|
| `examples/market-smoke.ts` | 市场闭环冒烟 | 具体任务（两数之和）+ 具体账户布局（w1/w2/r1-r3/pub，stake 15/8） |
| `bench/` | humaneval/judge/run/report/extract | HumanEval 实验（具体数据集 + 评分） |
| `schedulers/bootstrap.ts` | ensure weighted-scorer instance | 装配具体调度器实例（种子 candidates） |
| `schedulers/weighted-scorer.ts` `arena-scheduler.ts` `arena-definition.ts` `context-experiment.ts` | 具体调度器实现 | 特定调度策略 |
| `optimizers/weighted-tuner.ts` `ws-projector.ts` | 具体优化器实现 | 特定优化策略 |
| `workloops/`（managed-loop/market-bid-loop/pi-default-loop/budgeted-history/executors/...） | 具体执行循环实现 | 特定 loop 行为（market-bid-loop 绑竞价场景） |
| `commands/`（arena-display/render-*） | CLI 展示 | 具体渲染场景 |

> **注意**：`workloops/`、`schedulers/`、`optimizers/`（复数目录）按"框架/插件"约定是**插件槽位**——其中**通用插件**（pi-default-loop、weighted-scorer 这类基础款）介于框架与构造之间：它们是框架的默认实现，但也可被替换。**场景绑定插件**（market-bid-loop、humaneval bench）是纯构造。

## 平台层（接入/服务——F 容器化的服务对象）

| 位置 | 内容 |
|---|---|
| `src/ptl/` | pit CLI（Ink TUI + tmux 会话）——**开发态接入层**，不该进容器 |
| `src/pth/` | HTTP 服务（Fastify + Redis/BullMQ）——**云就绪服务层** |
| `extensions/pit-communicate/pit-control/pit-providers/workflow` | pi 扩展（通讯/控制/提供者/工作流） |

---

## 对 E（Bootstrap）的指引

**E = 在构造层写一份"联邦引导脚本"**，复用框架层引擎：

1. 调 `assembly/public-bootstrap` + `economy/central-pool.ensureCentralPool` → 初始化中央池账户
2. 调 ledger `poolCredit`/mint 路径 → 发行初始货币（货币政策操作，审计可见）
3. 调 `economy/task-types.register` → 注册种子任务类型（如 `code`/`review`/`info`）
4. 调 `assembly/assembler.assemble` → 装配 operator + 首批 agent 实例
5. 联邦就绪验证（投影报表 + 闭环冒烟）

**E 不动框架机制**——只是把"当前靠测试 fixture 手工做的事"（mkEnv 里的建池/开户/注册）固化成一份**可复用的引导序列**。

## 对 F（容器化）的指引

- **进容器**：框架层引擎 + pth 服务层 + 构造的引导序列（E）。
- **不进容器**：ptl CLI（tmux 开发态）、bench/examples（实验/冒烟——可在容器外跑或按需）。
- **核心决策**（待 Q3 裁决）：框架层的状态（agent-lab SQLite 账本 + memory 域目录 + 事件总线）如何跨容器——共享卷 / 账本服务化 / postgres 化。

## 遗留

- **通用插件 vs 场景插件**的细分（workloops/schedulers/optimizers 复数目录内）——E 实施时按需标注。
- "一个联邦"的边界（单库多 agent vs 服务化）——F 架构设计时裁决。
