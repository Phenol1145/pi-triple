# Agent Lab Phase 5b 规划简报 — Shadow/Canary 自动化与自动发布

**日期**：2026-07-27　**状态**：待对抗复核
**前置**：main `cee9353`（P5a 已合并，710/710）；P5a 计划 `docs/plans/2026-07-26-agent-lab-phase-5a-optimizer-round-lifecycle.md` 与路线图 §7 为本简报的上下文。

## 1. 背景与缺口

P5a 交付了完整的人工闭环：Optimizer 注册/授权 DataAPI/六门禁提案/promote/rollback 新轮次/参考 weighted-tuner/命令族/生产 facade。路线图 §7 剩余两条门槛显式推迟到 P5b：

1. **Shadow/canary 基础设施与自动流转** — `lab_proposals.status` 与 `lab_rounds.status` 中的 `validated`/`canary`/`initial` 目前是 schema 保留状态，无人使用。
2. **自动触发与 auto-promote** — 目前 Optimizer 只能手动 `/lab optimizer run`，promote/rollback 只能手动。

## 2. P5b 范围提案（四项能力）

### 2.1 Shadow 评估（离线重打分）

- 提案提交后（或提交时同步），用**候选参数**对数据窗口内的历史 dispatch 重算加权分，与当前参数的选择结果对比：
  - 数据源：legacy `runs` 表（P5a Option A 同源）— 含 per-run 的 completion/cost/tool_success 等终局指标与 model。
  - 重打分：候选 weights × 既有指标向量 → 每行重排名 → 统计"候选会选不同模型"的比例、预期质量/成本差。
  - 产物：写入 proposal `evaluation`（扩展 shadow 段）+ `optimizer.shadow.completed` 事件。
- **关键疑问 Q1**：runs 表是否有足够的原始指标向量支持重打分？还是需要查 signals_json / 其他列？（需复核 telemetry 写入端实际落库字段。）
- **关键疑问 Q2**：shadow 失败/数据不足时是阻塞提案（status 保持 pending）还是仅标注（shadow: "insufficient-data"）？倾向后者，与 P5a fail-open 一致。

### 2.2 Canary 流量切分

- `promoteRound` 之外新增 **canary 发布**：候选 round 进入 `canary` 状态，dispatch 时按百分比（如 5%/10%）随机钉到候选 round，其余钉当前 active round。
- 落点：dispatch 路径的轮次选择（当前在 `createSchedulerRuntime`/`resolveSchedulerInstance` 附近，读 `instance.currentRoundId`）。
- **关键疑问 Q3**：钉选发生在 runtime dispatch 还是 runner？同一 traceId 内必须单轮次（与 P5a"轮次不可变"不变式一致）。canary 钉选结果需要可观测（dispatch 事件带 roundId？现有事件是否已带？）。
- **关键疑问 Q4**：ws 的 runs 遥测没有 round 关联（P5a 已知），canary 效果评估靠什么归因？选项：(a) 给 runs 写路径加 round_id 列（additive，但 runner 写遥测在旧 store 层——P5a 决策是不动 runner；P5b 是否可以动？）；(b) 用 dispatch 事件时间窗近似归因（延续 Option A 近似）；(c) canary 期间按"钉选记录表"（新增小表记录 dispatch→roundId）做精确归因。

### 2.3 自动触发器

- Optimizer run 由条件自动触发：每 N 条 runs / 每 T 时间 / dispatch 钩子。
- **关键疑问 Q5**：触发器跑在哪个 tick 上？pi 扩展没有后台事件循环保证；可选：(a) dispatch 后钩子（每次 dispatch 检查条件，节流）；(b) 命令侧惰性检查（下次任意 /lab 命令时补跑）；(c) setInterval（扩展进程内定时器，需处理与会话生命周期关系）。

### 2.4 自动流转与 auto-promote

- 状态机：`pending → validated（shadow 通过）→ canary（人工或自动启用）→ promoted`；失败路径：`canary → rolled-back（自动，指标恶化）`。
- auto-promote 策略：canary 累积 ≥N 样本且关键指标不劣化（completion 不下降超过 ε、成本不上升超过 ε）→ 自动 promote（复用 P5a 全部门禁与 supersede 纪律）。
- 安全：auto-promote/auto-canary 默认关，config 显式开启；每一步都走 ControlPlane 门禁（不绕过 P5a 安全模型）。
- **关键疑问 Q6**：auto 流转的判定 tick 与 2.3 同一机制？评估数据窗口与 P5a `[currentRound.createdAt, now]` 的关系（canary round 自己的 createdAt 起算）？

## 3. 明确不做（防范围蔓延）

- 不动 P5a 已验收的六门禁与手动闭环行为（默认配置下 P5b 全部能力关闭时行为与 P5a 完全一致）。
- 不做多目标 Pareto / 统计显著性检验（p 值/置信区间）——minSamples 阈值即够。
- 不做跨 scheduler 类型（Arena）的 canary——P5b 只覆盖 weighted-scorer；Arena 轮次实验留待后续。
- 不改 legacy classic/market 分支（P7）。
- 不做 UI 美化；命令输出维持文本 notify。

## 4. 验收门槛草案

1. Shadow 评估产物可追溯：proposal.evaluation 含 shadow 段 + 事件；数据不足时如实标注不阻塞。
2. Canary 钉选确定可观测：每次 dispatch 的轮次归属可查（事件或表）；同 traceId 单轮次不变式保持。
3. 默认关闭时与 P5a 行为逐位一致（现有 710 测试零修改通过）。
4. Auto-promote 复用全部 ControlPlane 门禁；失败/异常只产生事件，不破坏轮次。
5. 全部新能力有测试：状态机流转、钉选分布（统计容差）、自动触发节流、auto-promote 门禁复用、fail-open。
6. 路线图 §7 两条 ⬜ 门槛转 ✅。

## 5. 规模预判

预估 6-8 个任务：shadow 重打分引擎、proposal evaluation 扩展、canary 钉选 + 归因、状态机流转服务、自动触发器、auto-promote 策略、命令扩展（`/lab optimizer canary|validate|auto`）、集成测试 + 文档。
