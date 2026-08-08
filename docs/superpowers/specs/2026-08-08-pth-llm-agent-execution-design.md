# PTH LLM 主导执行设计（agent 循环 + 多模型 + 任务分化）SPEC v1.0

> 日期：2026-08-08 · 状态：已批准（用户裁决 5/5） · 关联：[任务链 SPEC](./2026-08-08-pth-task-resolver-design.md) · [REPL SPEC](./2026-08-08-pth-multilang-repl-design.md) · [性能计量 SPEC](./2026-08-08-pth-perf-metrics-design.md)

> **整理说明（2026-08-09）**
>
> 文档性质：已批准的分阶段设计，并包含 Phase 1 后的实验记录。
>
> 实施映射：基础 agent loop、动作解析和工具表已存在；完整 kind 分化、verify、四级模型覆盖及 Phase 2/3 内容未观察到完整落地。
>
> 阅读关系：本文将 REPL、capability、角色和 Refine 组合为意图任务路径；其中性能数字是特定实验结果。参见[Kernel 设计综合总览](./2026-08-09-pth-kernel-design-synthesis.md)。

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

### 工具动作协议（LLM ↔ 执行器，已定稿 2026-08-08）
```
消息结构（对话形态，每步一轮）：
  [system] 角色人设 + 工具协议说明（JSON schema）+ 输出要求
  [user]   任务描述
  [assistant] { "thought": "推理说明（仅记录）", "action": { "tool": "<tool-id>", "args": {...} } }
  [user]   ── 工具结果回填（Observation 转文本）──
  ...循环...
  [assistant] { "action": { "tool": "done", "args": { "result": {...}, "summary": "..." } } }
```

工具清单（与 capability 白名单 + memory 对齐，零新能力）：
| tool | args | 说明 |
|------|------|------|
| python.execute | { code } | REPL 通道 |
| bash.execute | { command } | REPL 通道 |
| ts | { code } | vm 内联代码 |
| llm.complete | { user, system?, model? } | 子 LLM 调用（模型可覆盖） |
| web.fetchText | { url } | 只读网络 |
| fs.readText / fs.list | { path } / { dir? } | toolstore 文件通道 |
| state.recallFunctions / recallInsights | { query? } | 记忆召回（只读） |
| memory.retrieve | { anchors, kinds?, limit? } | 记忆检索 |
| memory.write | { id?, kind, anchors, content } | 记忆主动沉淀（LLM 自觉维护） |
| done | { result, summary? } | 终止 + 最终产出 |

结果回填：Observation 转文本（ok/value/stdout/stderr/truncated），截断保护复用现有策略。

解析与校验（容错链）：剥离围栏 → 提取首个 JSON → 校验 tool 白名单 → args 匹配 → 失败重试 1 次（PTH_AGENT_RETRY_PARSE）→ 仍失败 terminal reject（action-parse-failed）。

循环控制：done 正常终止；steps >= PTH_AGENT_MAX_STEPS（10）强制 done；总时长 > PTH_AGENT_TIMEOUT_MS（120s）reject；连续 N 次相同动作（tool+args 指纹）强制 done/reject（防死锁）。

verify（可选，PTH_AGENT_VERIFY=on）：done 前追加验证轮（LLM 输出 { pass, reason }）→ fail 允许重试（PTH_AGENT_VERIFY_RETRY 默认 1）。

可观测性：每步日志（step/tool/thought 前 50 字/durationMs/tokens）+ 指标（pth_agent_steps_total{tool} / pth_agent_loop_duration_seconds）+ transcript 完整轨迹（refine 快照更丰富）。

实现位置：src/pth/kernel/execution/agent-loop.ts（LLMAgentLoop.run + tools/agent-tools.ts 工具表 + parse-agent-action.ts 解析纯函数）
```

- LLM 输出（每步一条 JSON 动作）：

### 角色 prompt 接入（人设个性化）
```
现有 7 角色 prompt（"你是分析者——负责信息分析..."）→ 成为 LLM 的 system prompt 前缀
  analyst   → system: 角色人设 + 工具说明 + 输出协议
  developer → 同上（实现导向）
  ...
角色 = agent 循环的人设模板（不再零消费）
```

## 5. REPL 作为 LLM 的工具（PTH 式 PTC——多 REPL 程序化组合）

### 设计定位（PTH 拓展 Prime Agent 理念）
Prime Agent：单 persistent IPython，一切能力塞进一个环境（PTC = 在 Python 内写程序组合）。
PTH 拓展：**多 REPL kernel 分离**（ts vm 沙箱 / python 进程 / bash 进程，各自独立隔离）——
**LLM 在 ts vm（总指挥环境）写程序，程序内调度各 kernel**：

```ts
// PTC 程序示例：单程序组合 PythonKernel + BashKernel
const py = await python.execute("def fib(n): ...\n_result = fib(25)");
const b = await bash.execute(`echo ${py.value} | grep -q . && echo verified`);
return { fib25: py.value, verified: b.stdout.includes("verified") };
```

| 对比 | Prime | PTH（拓展） |
|------|-------|------------|
| REPL | 单 IPython | **三 REPL 分离**（ts/python/bash） |
| 组合方式 | 一切在 Python 内 | **LLM 在 ts vm 写程序调度各 kernel** |
| 隔离 | 无沙箱 | **vm 白名单指挥层 + 独立 kernel 进程** |

### 跨语言持久化与 PTC 的关系（设计意图）
**snapshot 聚合三 kernel + refine 跨语言提炼 + 召回重放 = PTC 的支撑体系**：
- 任务完成后 snapshot 聚合 ts 变量/函数 + python globals + bash cwd/env
- refine 提炼 tool-function（源码+spec）**跨语言保存**——python 写的函数被后续任务用 ts 程序调度
- 召回 eval 重放或按 spec 重建——跨语言复用（已验证：fibonacci/factorial 跨任务召回）
- 记忆沉淀粒度从"单语言产物"升级为"跨语言工作流片段"（ts 壳 + python 内核 + bash 验证）

### 工具协议（act 阶段，PTC 程序模式）
```
LLM 每轮输出：
  { "action": { "tool": "ts", "args": { "code": "<ts 程序>" } } }   ← PTC 主形态（vm 内组合多 kernel）
  { "action": { "tool": "python.execute", "args": { "code": "..." } } }  ← 单 kernel 细粒度（简单步骤）
  { "action": { "tool": "done", "args": { "result": {...}, "summary": "..." } } }  ← 终止

prompt 指导：优先写完整 ts 程序组合多个 kernel（一步完成多步）；复杂中间步骤可用单 kernel 工具。
收益：LLM 调用 3 次→1-2 次/任务（压测：时间/token 省 ~40%）。
```

其余工具清单（bash.execute/llm/web/fs/state/memory——capability 白名单复用，调用者从任务代码换成 LLM）：
| tool | args | 说明 |
|------|------|------|
| python.execute | { code } | REPL 通道（程序内亦可 subprocess 组合 bash） |
| bash.execute | { command } | REPL 通道 |
| ts | { code } | **PTC 主形态**：vm 内程序化调度各 kernel |
| llm.complete | { user, system?, model? } | 子 LLM 调用（模型可覆盖） |
| web.fetchText | { url } | 只读网络 |
| fs.readText / fs.list | { path } / { dir? } | toolstore 文件通道 |
| state.recallFunctions / recallInsights | { query? } | 记忆召回（只读） |
| memory.retrieve | { anchors, kinds?, limit? } | 记忆检索 |
| memory.write | { id?, kind, anchors, content } | 记忆主动沉淀（LLM 自觉维护） |
| done | { result, summary? } | 终止 + 最终产出 |

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

## 9.5 实测验证（Phase 1 落地后，2026-08-08）

### 实现关键修复：单轮消息模式
实测发现 deepseek-v4-flash（qwen-token-plan-cn 代理）对 system+user+assistant+user 多轮消息序列返回**空 content**——agent 循环改为单轮模式：不回放 assistant 消息，工具结果轨迹并入 user（每步重建），模型稳定输出 JSON 动作。

### 端到端验证
5 个 NL 任务全部成功（3-4.6s/任务）：多步闭环（python 算 → bash 验证 → done 提交，fib25=75025）真实发生。

### 压测结论（重新计量——旧估计严重低估）

| 维度 | 代码任务（旧） | agent 任务（新） | 说明 |
|------|--------------|----------------|------|
| 耗时/任务 | 0.1-1.2s | **3-4.6s** | LLM 推理占 95%（~3 次调用 × 1.03s/次） |
| tokens/任务 | ~335 | **~1200**（1080 in + 112 out） | 3.6x——LLM 真实理解+多步决策的代价 |
| 内存/产线 | ~300MB | **~258MB** | 懒 spawn 按需（5 python 非 7） |
| LLM 调用/任务 | 1（refine） | 2-3（决策+refine） | |

**关键洞察**：
- 时间瓶颈 = 模型推理延迟（~1s/次），工具执行（REPL 管道）仍毫秒级
- 10 batch 场景：内存可控（~2.6GB），但峰值 70 路 LLM 并发——**真实瓶颈从计算/内存变成 LLM 吞吐/限速**
- 扩缩容未来增强：基于 LLM in-flight 并发（而非仅 pending 数）的扩容信号（PTH_BATCH_SCALE 预留）

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
