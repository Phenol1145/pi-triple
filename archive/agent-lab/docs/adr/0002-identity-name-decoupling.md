# 实例实体用 UUID 身份 + 可变 name（身份/名称解耦）

调度器/优化器等**实例实体**此前用名称字符串作主键（如 `"default-arena"`），导致 `cfg.scheduler.instanceId`（派发目标）与 bootstrap 实例名错配时级联崩溃（见 1e4eb56 修复的 live bug）。我们决定：实例实体改用**不可变 UUID 身份 + 可变 name**，身份与名称解耦；**定义**（类型 id）保持语义名；**事件** event_id 保持确定性幂等键。

**理由**：
- UUID 身份根本消除名称碰撞/错配类 bug（名称只是可变属性，不参与身份判定）。
- 改名（如 arena→market）只改 name 字段，UUID 身份与所有外键不变——重命名零迁移。
- 与 Agent 实例一致（lab_agent_instances 自 Phase 1.5 已用 UUID）。

**适用范围**（见 CONTEXT.md「身份与命名」）：
- **UUID 身份 + name**：Scheduler Instance、Optimizer Instance、Agent（已是）、Optimization Round、Routing Binding。
- **保持语义名（不 UUID 化）**：Definition/类型 id（`market`/`weighted-scorer`/`pi-default-loop`/`weighted-tuner`，代码按 names.ts 常量引用）；Event event_id（确定性幂等键）。

## Considered Options

- **名称字符串作主键（natural key，原状）**：可读性高，但名称错配即崩溃、改名需全量迁移外键。已暴露真实 bug，否决。
- **UUID 身份 + name（选定）**：surrogate key 模式（业界标准）。代价是一次 schema 迁移 + UUID 可读性较低（用 name 字段 + join 缓解）。

## Consequences

- 需要 schema 迁移：lab_scheduler_instances / lab_optimizer_instances / lab_optimization_rounds / lab_routing_bindings 的主键与外键改为 UUID，加 name 列；lab_agent_instances 已是 UUID。
- bootstrap 改为 findOrCreate by (definition_id, name) → 返回 UUID（幂等）。
- 遥测事件 identity 中嵌入的实例标识：事件 event_id 保持确定性幂等键（不改），identity payload 可携带 UUID 或 name（实现时定）。
- 派发目标 `cfg.scheduler.instanceId` 用逻辑 name，拦截器按 (definition_id, name) 查 UUID。
- 此决策使 arena→market 术语统一变为「改 name 字段」的轻量操作（不再是全量字符串迁移）。
