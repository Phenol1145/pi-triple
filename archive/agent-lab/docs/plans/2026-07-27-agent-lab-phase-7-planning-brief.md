# Agent Lab Phase 7 规划简报 — 兼容入口收敛与旧路径退役

**日期**：2026-07-27　**状态**：待对抗复核
**前置**：main `9c5a288`（P1-P6 全部验收，1149/1149）；路线图 §9。

## 1. 背景

路线图 §9：新架构覆盖所有行为后，收敛命令、工具、数据库和拦截器入口。交付物：classic/market 到默认 SchedulerInstance 的最终迁移；统一 `/lab` 控制面与 `agent_lab` 结构化 actions；旧 interceptor/telemetry 分支退役；数据迁移完成标记和只读备份；运维/诊断/回滚/升级文档。

## 2. 现状关键事实（已勘察）

**仍存活的 legacy 面**：
1. `src/interceptor/register.ts`（109 行）：scheduler bridge（select 模式）之后保留两级 fallback——`market` 分支（`market.allocate`，~65-82 行）与 `classic` 分支（`recommend`/`decideIntercept`/pin/select UI，~84-105 行）。用户生产配置 `mode: "market", autoApply: true`。
2. `src/arena/` legacy 模块：`market.ts`、`ledger.ts`、`policies.ts`、`register.ts`——被 interceptor market 分支使用；Arena kernel（P4a `src/schedulers/arena-scheduler.ts` + arena-definition）是新路径。
3. `src/scorer/`：`recommend`/`decideIntercept` 被 classic 分支与 commands（`/lab recommend`?）使用；`scoreCandidates` 被 weighted-scorer 与 shadow **复用（非 legacy）**。
4. `src/store/`（runs 表 + pins）：runs 表是遥测主存储，被 ws-projector/canary-eval/telemetry **共用（非 legacy）**；pin 机制（setPin/getPin）是 classic 专属。
5. `src/telemetry/`：runs 写入 + settle（与 scheduler bridge settle 并存）——P4b 之后 ws settle 走哪条路需复核。
6. config `mode: "classic" | "market"`：P4b 已交付 `/lab mode` 活绑定重写（setCatchAllBinding），mode 绑定可指向 SchedulerInstance；但 legacy 分支仍在 bridge 失败时兜底。

**已被新架构覆盖的行为**：模型选择（ws select）、竞价分配（arena-scheduler select）、遥测聚合（runs + projectors）、优化闭环（P5）、上下文实验（P6）。

## 3. 核心疑问（需对抗复核裁决）

- **Q1（退役顺序与原子性）**：interceptor 两级 fallback 如何安全移除？是直接删除（bridge abstain/fail → 不改写 model，host 默认行为）还是先加一个"legacy 影子期"（只记日志不生效）？fail-open 语义变化：legacy 删除后 bridge 失败 = 不改写（现状 = 落 market/classic）。行为差异可接受吗？
- **Q2（config 迁移）**：`mode: "market"` 如何映射？P4b 的 setCatchAllBinding 已能把 market 模式绑定到 arena instance。迁移是：(a) 启动时检测 mode!=classic → 自动写 binding + 标记迁移完成；还是 (b) 显式 `/lab migrate` 命令一次性执行？config 里的 `mode` 字段本身退役成什么？
- **Q3（legacy 模块删除边界）**：`src/arena/market.ts/ledger.ts/policies.ts/register.ts` 全删？（arena kernel 是否复用其中任何代码——ledger 概念在 kernel 里是新实现还是复用？）`src/scorer/` 只删 recommend/decideIntercept 保留 scoreCandidates/completion？pin 机制整体删除？
- **Q4（数据处置）**：pins 表删除还是只读保留？runs 表保留（共享）。迁移完成标记写在哪（config? store meta 表?）？"只读备份"具体指什么——DB 文件复制？
- **Q5（telemetry settle 收敛）**：P4b 之后 tool_execution_end 的 settle 是否已统一走 bridge settle？legacy settle 路径是否还在使用？
- **Q6（agent_lab 工具 actions 收敛）**：当前 `agent_lab` 工具有哪些 actions？需要新增/收敛什么？
- **Q7（验收怎么测"足够真实运行"）**：路线图前置条件第二条是判断性的——以什么证据关闭？（建议：退役前用 `/lab arena smoke` + 真实 dispatch 验证 bridge 路径在用户配置下工作。）

## 4. 范围提案

1. **迁移工具**：`/lab migrate`（或启动自动检测）——mode→binding 映射写入、迁移完成标记、DB 备份（复制 store 文件）。
2. **interceptor 收敛**：删除 market/classic 分支；bridge abstain/fail → 不改写（fail-open 语义保持：从不阻断 dispatch）。
3. **legacy 模块退役**：按 Q3 裁决删除/保留；pin 机制与 pins 表处置按 Q4。
4. **统一控制面**：`/lab` 命令族审查收敛（去掉 legacy-only 命令或改写）；`agent_lab` actions 按 Q6。
5. **文档**：README 运维/诊断/回滚/升级节；CHANGELOG 式迁移说明；路线图 §9 验收。

## 5. 明确不做

- 不动新架构任何已验收行为（ws/arena kernel/optimizer/workloop/experiment）。
- 不删 runs 表、不删事件日志、不删 lab_* 表。
- 不做 host 侧（pi 本体）改动。
- 删除前保留一个标记提交（tag 或分支）便于回滚。

## 6. 验收门槛草案

1. 删除后全部测试通过（legacy 测试随代码删除，非 legacy 测试零修改）；测试数预期**下降**——明确区分"删除的 legacy 测试"与"必须保持的基线"。
2. 用户生产配置（mode: market）迁移后：bridge 路径承担全部分配；interceptor 从不阻断。
3. 迁移完成标记 + 备份文件存在且可验证。
4. 路线图 §9 验收门槛逐条 ✅。
