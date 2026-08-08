# PTH LLM 主导执行设计（agent 循环 + 多模型 + 任务分化）SPEC v1.0

> 日期：2026-08-08 · 状态：已批准（用户裁决 5/5） · 关联：[任务链 SPEC](./2026-08-08-pth-task-resolver-design.md) · [REPL SPEC](./2026-08-08-pth-multilang-repl-design.md) · [性能计量 SPEC](./2026-08-08-pth-perf-metrics-design.md)

## 1. 背景与动机

PTH 的构建初衷：**任务池是给 LLM 驱动的 agent 干活的**——任务 = 意图/工单，worker = LLM 主导的 agent（理解 → 规划 → 执行 → 验证 → 交付）。

当前实现偏离初衷（工程妥协链）：

| 现状 | 问题 |
|------|------|
| 任务 text 必须可执行代码（NL 任务反复 reject 的教训 → 代码形态） | 发布者/转译器把"LLM 该做的决策"提前写死 |
| TaskLoop 机械认领 + 纯代码 vm 执行 | LLM 只在 NL 转译（一次性）和 refine（完成后）做配角 |
| 全部 worker 共用一个全局模型（deepseek-v4-flash） | 无 per-worker 模型差异化 |
| 角色 prompt（analyst/developer...）零消费 | 角色只是路由标签，agent 人设从未接入 |
| REPL 三件套由"任务代码"调用 | 设计意图是**给 LLM 当工具**（agent 循环内动态选择） |

**本设计恢复 PTH 初衷**：LLM agent 执行循环主导，REPL 成为 LLM 的工具，多模型按 worker/环节/任务分层，确定性组件退居辅助。

## 2. 设计原则（用户裁决）

1. **任务分化先于角色分化**：任务 kind（intent/code/chain/ops）是主键，决定处理路径；角色是路径上的个性化（LLM system prompt），不是先验实体。
2. **LLM 驱动 worker 主导，确定性 worker 辅助**：意图型任务由 LLM agent 循环执行（PTH 的存在意义）；调度器/路由/监控/转译/校验等确定性组件零 LLM，支撑系统运行。
3. **REPL 是 LLM 的工具**：python/bash/ts 三件套在 agent 循环内由 LLM 动态调用（多步迭代），不是任务代码的静态调用。
4. **多模型分层**：每个 worker 可调用不同 LLM（角色级/环节级/任务级三级覆盖），计量按 provider/model 自动分流。

## 3. 任务分化（kind 主键）

```
任务发布（text + tags）→ 确定 kind（publish 时解析，存 tasks.kind 或 payload.kind）：
  kind=intent   意图型（默认）：LLM agent 理解+规划+执行+验证
  kind=code     代码型：text 直接 vm 执行（现有路径，零回归）
  kind=chain    链型：payload.flow 路由（现有 resolver 处理）
  kind=ops      系统维护型：确定性执行（VACUUM/参数调整等——预定义脚本或受控命令）

路由：
  kind 先决 → 执行路径选择
  角色（assigned_role）保留 → 执行路径内的个性化（system prompt + 模型配置）
```

### kind 判定
- payload.kind 显式指定（发布者控制，最高优先）
- 无指定 → 默认 intent（**恢复"任务是给 agent 干的"初衷**；代码任务需显式 kind=code 或 tags 含 code）

> 兼容：现有代码任务（无 kind）→ 默认 intent 会走 agent 循环（行为变化）——**迁移策略**：v0.4 发布时默认仍 code（PTH_TASK_DEFAULT_KIND env 可切），Phase 2 完整落地后切 intent 默认。

## 4. 核心：LLM 执行循环（agent loop）

```
TaskLoop（intent 模式）——Spec B §5 预留环节落地：
┌────────────────────────────────────────────────┐
│ 1. assess    LLM 读任务：能完成吗？              │
│              不能 → terminal reject（带原因分类） │
│ 2. plan      LLM 生成动作（结构化 JSON）：        │
│              { tool: "python.execute", args: "..." } │
│ 3. act       执行工具（REPL/llm/web/fs/state）   │
│ 4. observe   结果回填 LLM 上下文（截断保护）      │
│ 5. iterate   LLM 决定下一步（继续/结束）          │
│              上限 PTH_AGENT_MAX_STEPS（默认 10） │
│ 6. verify    LLM 自检：结果 vs 任务要求           │
│              （可选环节，PTH_AGENT_VERIFY 开关）  │
│ 7. submit    产出（结果 + LLM 完成说明）          │
└────────────────────────────────────────────────┘
```

### 工具动作协议（LLM ↔ 执行器）
```
LLM 输出（每步一条 JSON 动作）：
  { "tool": "python.execute" | "bash.execute" | "ts" | "llm.complete" | "web.fetchText" | "fs.readText" | "fs.list" | "state.recallFunctions" | "state.recallInsights" | "done", "args": {...} }
执行器执行 → 结果（Observation 结构）回填 → 下一步
"done" 动作携带最终产出 { result, summary }
```

- 动作解析失败（非 JSON/未知 tool）→ 重试一次（PTH_AGENT_RETRY_PARSE）→ 仍失败 terminal reject
- 上下文预算：每步回填截断（复用截断策略），超预算强制 done（PTH_AGENT_MAX_TOKENS 可选）
- 超时：整循环 PTH_AGENT_TIMEOUT_MS（默认 120s）→ reject

### 角色 prompt 接入（人设个性化）
```
现有 7 角色 prompt（"你是分析者——负责信息分析..."）→ 成为 LLM 的 system prompt 前缀
  analyst   → system: 角色人设 + 工具说明 + 输出协议
  developer → 同上（实现导向）
  ...
角色 = agent 循环的人设模板（不再零消费）
```

## 5. REPL 作为 LLM 的工具

```
调用者变化：任务代码（现状）→ LLM agent 循环（目标）
  capability 白名单【完全复用】（python/bash/ts/llm/web/fs/state）
  多步迭代示例：
    LLM: { tool: "python.execute", args: "def fib(n):...\n_result = fib(25)" }
    → observe: {"value": 75025}
    LLM: { tool: "bash.execute", args: "echo 75025 | wc -c" }   # 交叉验证
    → observe: {"stdout": "6"}
    LLM: { tool: "done", args: { result: { fib25: 75025 }, summary: "..." } }
```

## 6. worker 模型

### LLM 驱动 worker（主角）
```
TaskLoop（intent 模式）+ 多模型路由 + REPL 工具集
每 worker 配置：角色人设（prompt）+ 模型解析链（见 §7）
```

### 确定性 worker（辅助，零 LLM）
```
scaler（扩缩容）/ resolver（链路由）/ watchdog（监控）/ 转译器 / 校验器
——不处理意图型任务，纯程序驱动（现状保留，明确其"辅助"定位）
```

## 7. 多模型分层（per-worker 可调）

```
模型解析优先级（每次 complete 时解析）：
  ① 任务级：payload.model（发布者指定该任务全环节模型）
  ② 环节级：PTH_AGENT_MODEL_VERIFY（verify 用更强模型，如 deepseek-v4-pro）
  ③ 角色级：PTH_AGENT_MODEL_<ROLE>（如 PTH_AGENT_MODEL_ANALYST=deepseek-v4-pro）
  ④ 全局默认：PTH_AGENT_MODEL ?? deepseek-v4-flash（plan/act 决策）

示例配置：
  PTH_AGENT_MODEL=deepseek-v4-flash           # 全局（决策快）
  PTH_AGENT_MODEL_VERIFY=deepseek-v4-pro      # 验证更严格
  PTH_AGENT_MODEL_ANALYST=deepseek-v4-pro     # 分析角色整体用 pro
  # 发布：payload.model = "qwen3.8-max"       # 单任务指定
```

### 计量（现状已支持，增强）
```
现有：pth_llm_calls_total{provider,model} + pth_llm_tokens_total{type}  ← 自动分流多模型
增强（Phase 3）：
  pth_llm_calls_total{provider,model,role}    # 按角色看消耗
  pth_llm_tokens_total{type,stage}            # 按环节（plan/act/verify/refine）看消耗
```

## 8. 与现有资产的关系（全部保留）

| 资产 | 变化 |
|------|------|
| REPL 三件套（ts/python/bash + 懒 spawn/空闲回收/ns reset） | 调用者从任务代码 → LLM 工具（复用） |
| capability 白名单 | 不变（LLM 动作的可用工具集） |
| 正交化路由（assigned_role） | 保留（kind 先决，角色次之） |
| 自动扩缩容 / watchdog / 监控 / 日志 | 不变（确定性辅助体系） |
| refine 记忆闭环 | 保留（agent 完成后照常提炼） |
| NL 转译（tags=nl） | 降级为 fast-path（简单任务一次性转译）；复杂任务走 agent 循环 |
| 代码任务（kind=code） | 直接执行（零回归） |
| TaskResolver 链 | 保留（chain 型任务路径） |

## 9. 参数化（仿 PG 风格，env 可调）

```
PTH_AGENT_MODE           on/off（默认 on；off = 回退代码执行路径）
PTH_TASK_DEFAULT_KIND    code|intent（默认 code——兼容迁移；Phase 2 后切 intent）
PTH_AGENT_MAX_STEPS      默认 10
PTH_AGENT_TIMEOUT_MS     默认 120000
PTH_AGENT_VERIFY         on/off（默认 on）
PTH_AGENT_RETRY_PARSE    默认 1（动作解析失败重试次数）
PTH_AGENT_MODEL          默认 deepseek-v4-flash
PTH_AGENT_MODEL_VERIFY   默认空（沿用全局）
PTH_AGENT_MODEL_<ROLE>   按角色覆盖
```

## 10. 落地节奏

```
Phase 1（核心骨架）：
  - TaskLoop intent 模式（assess→plan→act→observe→iterate→verify）
  - 工具动作协议（JSON 动作解析 + 执行 + 回填 + 截断）
  - 角色 prompt 接入 system
  - 多模型解析链（任务/环节/角色/全局四级）
  - 端到端验证：NL 意图任务多步执行（python 算 → bash 验证 → done）
Phase 2（kind 分化完整化）：
  - intent/code/chain/ops 四类路由（publish 解析）
  - ops 型确定性执行器挂载
  - PTH_TASK_DEFAULT_KIND 切 intent
Phase 3（深化）：
  - verify 失败自动重试（有限次）
  - 计量加 role/stage 维度
  - assess 与正交化联动（kind 不匹配 → 定向 reject）
```

## 11. 风险与对策

| 风险 | 对策 |
|------|------|
| agent 循环成本（每任务多次 LLM 调用） | 计量透明（按 model/role 分流）+ max_steps 上限 + 简单任务 fast-path |
| LLM 动作解析失败/幻觉工具 | 重试 + 白名单校验 + terminal reject（不回池） |
| 上下文膨胀（多步回填） | 截断策略复用 + 预算上限强制 done |
| 现有代码任务回归 | kind=code 直通路径保留 + 默认仍 code（迁移期） |
| 模型差异导致行为不稳定 | 角色级固定配置（PTH_AGENT_MODEL_<ROLE>）+ 可观测 |
| 循环死锁（LLM 反复同动作） | 重复动作检测（连续 N 次相同 → 强制 done/reject） |

## 12. 裁决记录

| # | 裁决 |
|---|------|
| 1 | 任务分化先于角色分化（kind 主键，角色 = 人设视图） |
| 2 | LLM worker 主导，确定性 worker 辅助（LLM 是主角非配角） |
| 3 | REPL 三件套是 LLM 的工具（agent 循环内动态调用） |
| 4 | 多模型分层：任务/环节/角色/全局四级解析（非单模型全局） |
| 5 | 计量按 provider/model 分流（现状已支持），Phase 3 加 role/stage 维度 |
| 6 | 代码任务（kind=code）保留直通路径（零回归） |
| 7 | 角色 prompt 接入 LLM system（人设个性化，不再零消费） |
| 8 | NL 转译降级为 fast-path（复杂任务走 agent 循环） |
