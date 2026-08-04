# Implementation Plan: 代码质量收敛（模块化 + 复用率）

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于代码审计结果，收敛 agent-lab 内部模块化与复用率——解 4 个 import 环、统一事务入口、抽公共测试 fixture、补 index.ts 桶导出、固化目录约定、理清 Ledger 三定义委托链。**不动 P0 容器化耦合点**（属子项目 F）。

**Architecture:** 全部在 `extensions/agent-lab`（node:test，`.ts` 后缀，零新增依赖）。原则：**风险递增、每项独立 commit、全程测试绿**（基线 1636 pass / 2 pre-existing）。

**审计依据**：`docs/superpowers/2026-08-03-market-economy-overview.md` 审计结果（4 scout 并行）——4 import 环 / 事务双轨 / fixture 重复≥18 / 0 index.ts 桶导出 / 六目录单复数并存 / Ledger 三定义。

**前置事实（已核查）**：
- 环1：`arena/ledger.ts:4` import `economy/tx-utils`；`tx-utils.ts` **只依赖 node:sqlite**（纯工具）→ 可移 core。economy 5 文件 import arena/ledger。
- 环2：`arena/agent-id.ts:3` import `schedulers/weighted-scorer.modelToAgentCreateSpec`；该函数 **4 个消费方**（agent-id/bootstrap/agent-id.test/arena-bootstrap.test）→ 跨域共用，移 core。
- 环3：`workloop/runner.ts:455` buildSDK 内 `createInstrumentedModelPort(this.model,...)`（框架硬编码插桩）→ 依赖倒置为注入。消费方仅 model-port.ts（定义）+ runner.ts。
- 环4：`scheduler/runner.ts:6` import `schedulers/names` 的 2 常量（MARKET/WEIGHTED_SCORER definition id）→ 常量下沉 scheduler/。
- Ledger 三定义：`arena/types.ts Ledger`（胖接口 20+ 方法）/ `assembly/ledger-port.ts LedgerPort`（装配端口）/ `economy/voucher-port.ts LedgerOps`（debit/credit 最小面）——**非重复，是分层抽象**；理清委托链（LedgerOps ⊂ LedgerPort ⊂ Ledger）而非合并。

---

## Task 1: 解环 1——tx-utils 移到 core

**Files:**
- Move: `extensions/agent-lab/src/economy/tx-utils.ts` → `extensions/agent-lab/src/core/tx-utils.ts`
- Modify: `src/arena/ledger.ts`（import 路径）+ economy 5 文件（escrow/market-effects/org/central-pool/market-runner）+ 其余消费方
- Test: 现有 `arena-ledger.test.ts`（嵌套事务测试）应仍绿

**Step 1: 移动 + 改 import**

`git mv src/economy/tx-utils.ts src/core/tx-utils.ts`；全部 `from "../economy/tx-utils.ts"` / `from "./tx-utils.ts"` → 新路径。`rg tx-utils` 全量定位（src + test）。

**裁决**：tx-utils 是纯 db 协调器（只依赖 node:sqlite），属 core 基础设施层。arena（低层）+ economy（高层）都 import core——环断。

**Step 2: 全绿验证 + 环断确认**

`rg "economy/tx-utils"` 零命中；`node --test test/arena-ledger.test.ts test/market-effects.test.ts` 绿。

**Step 3: commit**

`refactor(agent-lab): tx-utils 下沉 core（解 economy↔arena 环——纯 db 协调器归基础设施层）`

---

## Task 2: 解环 4——scheduler definition id 常量下沉

**Files:**
- Modify: `src/scheduler/names.ts`（新建或扩充——框架层常量）或 `scheduler/contracts.ts`
- Modify: `src/scheduler/runner.ts`（import 改为本域）
- Modify: `src/schedulers/names.ts`（常量移出，保留 re-export 兼容或删）

**Step 1: 常量移到框架层**

`MARKET_SCHEDULER_DEFINITION_ID`/`WEIGHTED_SCORER_DEFINITION_ID` 从 `schedulers/names.ts` 移到 `scheduler/`（框架层——definition id 是框架应知的注册键）。runner.ts import 改本域。

**裁决**：schedulers/names.ts 若只剩这 2 常量则整文件移/删；若还有其他插件常量则框架常量与插件常量分离。**先读 names.ts 全貌再定**（保留 re-export 兼容避免大范围改）。

**Step 2: 全绿 + 环断确认**

`rg "schedulers/names"` 在 scheduler/ 域零命中。

**Step 3: commit**

`refactor(agent-lab): scheduler definition id 常量下沉框架层（解 scheduler↔schedulers 环）`

---

## Task 3: 解环 2——modelToAgentCreateSpec 移到 core

**Files:**
- Move: `modelToAgentCreateSpec` 从 `src/schedulers/weighted-scorer.ts` → `src/core/`（如 `core/agent-spec.ts`）
- Modify: 4 消费方（`arena/agent-id.ts`、`schedulers/bootstrap.ts`、`test/agent-id.test.ts`、`test/arena-bootstrap.test.ts`）

**Step 1: 移动函数**

纯转换函数（ModelInfo→AgentCreateSpec）移到 core。消费方 import 改 core。

**裁决**：4 消费方跨 arena+schedulers——非 agent-id 独占，归 core（共享转换）。**先读函数签名确认返回类型 AgentCreateSpec 的归属**（若 AgentCreateSpec 在 arena 则需类型也移或函数留 arena——裁决点）。

**Step 2: 全绿 + 环断确认**

`rg modelToAgentCreateSpec` 全部指向 core；agent-id 不再 import schedulers。

**Step 3: commit**

`refactor(agent-lab): modelToAgentCreateSpec 下沉 core（解 arena↔schedulers 环——跨域纯转换共享）`

---

## Task 4: 解环 3——createInstrumentedModelPort 依赖倒置（中风险）

**Files:**
- Modify: `src/workloop/runner.ts`（buildSDK 经注入获得 modelPort wrapper）
- Modify: `src/workloop/contracts.ts`（runner deps 增可选 `wrapModelPort?: (model, opts) => model`）
- Reference: `src/workloops/model-port.ts`（定义不动）

**Step 1: 失败测试**

```ts
// runner 构造时注入 wrapModelPort → buildSDK 用注入的 wrapper（非硬编码 createInstrumentedModelPort）
// 缺省（不注入）→ 仍用默认 createInstrumentedModelPort（向后兼容）
```

**Step 2: 实现（依赖倒置）**

`WorkLoopRunner` deps 增可选 `wrapModelPort`；buildSDK `model: (this.deps.wrapModelPort ?? createInstrumentedModelPort)(this.model, {...})`。**问题**：缺省值仍 import workloops/model-port——环未断？**裁决**：①默认 wrapper 逻辑内联到 workloop（插桩是框架能力，model-port 薄壳留 workloops re-export）②或 runner 强制注入（破现状）。**先读 createInstrumentedModelPort 实现复杂度**——若轻量（<30 行）则内联进 workloop/runner 或 workloop/model-port.ts 新建（框架层），workloops/model-port 改 re-export。环断。

**Step 3: 全绿 + 环断确认**

`workloop/` 不再 import `workloops/`。

**Step 4: commit**

`refactor(agent-lab): createInstrumentedModelPort 依赖倒置（解 workloop↔workloops 环——框架不硬编码插件）`

---

## Task 5: 统一事务入口（repository + ledger 裸 BEGIN）

**Files:**
- Modify: `src/core/storage/repository.ts:135`（裸 BEGIN IMMEDIATE → withSharedTransaction）
- Modify: `src/arena/ledger.ts:52`（裸 BEGIN → withSharedTransaction；:131 已用）

**Step 1: 失败测试**

```ts
// repository 相关多步写操作可嵌套在共享事务内（外层 withSharedTransaction 开启，内层 repository 方法复用）
// ledger:52 路径同
```

**Step 2: 实现**

repository/ledger 裸 `BEGIN IMMEDIATE` → `withSharedTransaction(this.db, ...)`（Task 1 后 tx-utils 在 core，repository 同域直接 import）。**先读两处裸 BEGIN 的上下文**（确认事务边界与嵌套安全——withSharedTransaction 幂等复用）。

**Step 3: 全绿 + commit**

`refactor(agent-lab): 统一事务入口 withSharedTransaction（repository/ledger 裸 BEGIN 收敛——事务双轨并一轨）`

---

## Task 6: 公共测试 fixture（test/test-utils）

**Files:**
- Create: `extensions/agent-lab/test/test-utils/fixtures.ts`（tmpDb/freshLedger/mkMemoryDir 等）
- Modify: ≥5 个高重复测试文件（memory-store/memory-dsp/memory-pipeline/assembly-*、economy-*）改用公共 fixture

**Step 1: 抽公共 fixture**

```ts
// fixtures.ts
export function tmpDir(prefix): { dir: string; cleanup(): void }
export function freshDb(): DatabaseSync  // :memory: + 常用 schema
export function freshLedger(db?): SqliteLedger
```

**Step 2: 迁移高重复测试**

挑 5-8 个重复最明显的（各 `fresh()` 几乎相同的）改用公共 fixture。**不全量迁移 18 处**（一次收敛风险大）——先建公共件 + 迁代表性样本，其余留后续。**裁决**：fixture API 对齐各测试的最小公共面（tmpdir+db+ledger）。

**Step 3: 全绿 + commit**

`test(agent-lab): 抽公共测试 fixture（tmpdir/db/ledger——收敛 18 处私有 fresh 造轮子，先迁代表样本）`

---

## Task 7: index.ts 桶导出（17 域目录）

**Files:**
- Create: `src/{economy,memory,assembly,core,arena,workloop,...}/index.ts`（桶导出各域公共接口）
- Modify: 无（仅加桶，不改消费方——深 import 兼容保留）

**Step 1: 逐域加 index.ts**

每域 `index.ts` re-export 公共面（接口 + 主类 + 常量）。**不改消费方**（深 import 仍可用——桶是新增便利，非强制）。**裁决**：哪些域优先（economy/memory/assembly/core——被引最多）；每域公共面 = 当前被外部 import 的符号集合（`rg 'from "\.\./<域>/'` 统计）。

**Step 2: 全绿 + commit**

`feat(agent-lab): 域 index.ts 桶导出（公共接口聚合——深 import 仍兼容，后续消费方渐进迁移）`

---

## Task 8: 目录约定固化（README/lint 文档）

**Files:**
- Create: `extensions/agent-lab/ARCHITECTURE.md` 或补 `CONTEXT.md`（目录约定段）

**Step 1: 固化"单数=框架契约，复数=具体插件"约定**

文档写清：optimizer/(框架) vs optimizers/(插件)、scheduler/ vs schedulers/、workloop/ vs workloops/ + 各 store/schema 归属 + Ledger 三定义委托链（LedgerOps ⊂ LedgerPort ⊂ Ledger 分层）。**不重命名目录**（改名成本高/风险大——文档固化约定即可）。

**Step 2: commit**

`docs(agent-lab): 目录约定固化（单数=框架/复数=插件 + Ledger 三层委托链——命名混乱以文档收敛非改名）`

---

## Global Constraints

- **风险递增顺序**：Task 1（最易）→ 2 → 3 → 5 → 6 → 7 → 8 → 4（环 3 中风险放最后，独立处理）
- 每任务：失败测试（或环断验证）→ 实现 → 全绿 → 独立 commit → 报告 `.superpowers/sdd/2026-08-05-code-quality/task-N-report.md`
- 基线：agent-lab **1636 pass / 2 pre-existing**（weighted-scorer-bootstrap）；PTL 717/717——**任何重构后必须仍 1636**
- 零新增依赖；import `.ts` 后缀；node:test
- **纯重构**——不改行为（所有测试不改断言语义，只改 import 路径/fixture 来源/桶导出）
- 环断确认：每解环任务跑 `rg` 证双向 import 已单向化
- Task 6 不全量迁 18 处（先公共件 + 代表样本）；Task 7 不改消费方（桶为新增便利）
