# Prime Agent 启发下的联邦架构下一阶段设计 · deepseek-v4-pro 方案

## 1. 总判断

Prime Agent 对联邦设计最重要的两个启发，我认为是：

**第一：PTC 不是"要不要统一工具面"的表面问题，而是"agent 是否拥有自己的可编程工作空间"的范式问题。** Prime Agent 的 persistent IPython kernel 本质上给了 agent 一个外部可编程 RAM——agent 可以在里面保存变量、定义函数、组合工具调用、异步并发执行。这不是"把工具调用改成 Python 代码"的语法糖，而是 agent 获得了一种新的能力：**它可以对自己的操作进行抽象和复用**。对比我们现在的联邦，agent 每一次工具调用都是离散的 function call——分选器认领、sorter? submit/reject、记忆写入、comms 发送——这些调用之间通过 LLM 上下文窗口串联，没有持久化的"中间状态"。PTC 的方向值得认真考虑，但我持**分阶段改造**而非激进推翻的立场。

**第二：`/refine` 的教训比它的机制更重要。** Prime Agent 的 self-improvement 机制（`/refine` 分析轨迹 → 最小 harness 修改）在 Factorio 实验中暴露了核心风险：错误目标 + 持续学习 = 越来越高效的错误行为。这不是 `/refine` 的技术实现问题，而是**自改进的治理问题**。我们的联邦设计已有治理基因（分析者拆分权限/记忆维护者审核/经济奖惩/公域审核矩阵），而 Prime Agent 缺少这一层。我认为我们的路线应该是在治理框架下引入自改进（"规则内获取最多货币"的目标约束 + 公域审核闸门），而不是模仿 `/refine` 的自由式 self-refinement。

一个补充判断：Prime Agent 的"持久 agent 会话"（rlm 创建可找回的子 agent）和我们的联邦在这个方向上同构，但它的实现更激进——子 agent 有独立 kernel、session tree、可长期驻留。我们的 fire-and-forget 派发模式在简单任务上足够，但对于需要"子 agent 产出阶段性成果、父 agent 组合多个子任务结果"的复杂场景（这正是分析者的核心工作模式），持久会话是必需的。

---

## 2. 对 A-E 各问题的明确立场

### A. 记忆的"工作记忆层"（会话内跨步状态，类似 RAM）

**立场：支持加入，但必须严格限定边界和生命周期。**

**具体机制：**

1. **定位为 L2.5 层**——介于 L2 数据域（不透明状态）和 L3 语义记忆（持久沉淀）之间，暂命名为"工作记忆域（Working Memory, WM）"。

2. **存储面**：agent-lab.db 新增 `working_memory` 表（或复用 tasks 表的 claimed 视图——因为 claimed 任务天然绑定 agent+会话）。存储内容：key-value 结构（key 为 agent 定义的变量名，value 为 JSON blob），带 `session_id` 分区和 `expires_at` TTL。不参与 L3 的版本化/CAS/审核链——它是会话内草稿，不是沉淀记忆。

3. **访问面**：通过 `sdk.memory` SDK 端口扩展两个方法：
   - `wmSet(key: string, value: any, ttlMs?: number)` — 写入工作记忆
   - `wmGet(key: string): any | undefined` — 读取工作记忆
   - 守卫：仅当前 agent 可读写自己的 WM；跨 agent 访问必须走 comms 或公域。

4. **生命周期**：
   - 默认跟随 agent 会话生命周期（会话结束 → WM 清空）。
   - 显式 TTL 可选（用于"这个计算结果在接下来的 N 分钟内有效"的缓存语义）。
   - 不进入 DSP 投影（WM 是 agent 自己的"Scratchpad"；但可选择性注入 DSP 投影区——由 agent 在 SSP 中声明 `wmKeys: ["plan", "currentPhase"]` 来把指定 key 推入 DSP）。

5. **为什么不做 kernel state 式的持久 Python 环境？** 因为我们没有 persistent IPython kernel 基础设施，且引入 Python 进程管理会大幅增加系统复杂度。WM 表方案是轻量替代——SQLite 作为"RAM"（类比 kernel state），读写由系统代码执行（不引入 LLM 写代码的自由度），SDK 封装。

6. **与现有记忆系统的关系**：WM 不是 L3 的替代或降级版——它是会话内的临时状态，不经过沉淀管道、不版本化。从 WM→L3 的路径：agent 显式调用 `sdk.memory.write()` 将 WM 中的关键发现沉淀为持久条目（走正常校验链）。

**为什么不赞成完全不做工作记忆：**
- 分选器认领多个任务后，agent 在一个会话内可能执行多个任务，任务之间的中间结果（如"已扫描的文件列表""已确认的环境状态"）现在全靠 LLM context 保存——context 压缩就丢。
- 分析者角色的核心工作模式是"拆分任务 → 收集各子任务结果 → 综合判断"，没有 WM 就意味着要么全塞进 context（容易溢出），要么每个子任务的结果都沉淀到 L3（过度持久化）。
- performance 角度：context window 是昂贵资源，WM 可以让 agent 把非关键的中间结果"换出"到 SQLite，减少 context 消耗。

---

### B. 持久 agent 会话（派发出去的子任务可被找回、继续、长期存在）

**立场：支持实现"轻量持久化"，但反对 Prime Agent 式的完整 session tree + 独立 kernel。**

**具体机制：**

1. **"在途任务"升级为"持久在途"**：tasks 表新增 `execution_context` TEXT 列（JSON：`{ sessionId, lastCheckpointSeq, status, resumedAt? }`）——记录该认领任务对应的 agent 执行会话信息。

2. **找回机制**：父 agent（分析者）可通过 `/lab task resume <taskId>` 或 `sdk.taskpool.resumeTask(taskId)` 找回之前派发的任务——系统将任务重新派发给原 agent（或原角色类型的另一个 agent），并注入该任务的 execution_context 作为上下文前缀。

3. **会话续派**：恢复时，将 `execution_context` 中的关键状态（WM 快照 + 已完成步骤摘要）注入 agent 会话的起始上下文。agent 不是"重新开始"，而是"从上次停下的地方继续"。

4. **与 fire-and-forget 的关系**：不替代，而是分层：
   - **fire-and-forget**：简单任务（单步执行、不需要结果组合）→ 默认模式。
   - **tracked（持久）**：复杂任务（需要等待子结果、需要阶段性汇报）→ agent 在 publish 时指定 `tracked: true`，任务进入 tracked 模式，execution_context 持续更新。

5. **长期存在**：使用 scheduled_jobs 既有机制——持久 agent 会话内部可注册周期性自检任务（如"每 5 分钟检查子任务完成情况"），利用现有定时器基础设施。

**为什么不赞成 Prime Agent 式的完整 session tree：**
- 我们的 agent 本质上是无状态的——会话结束后 LLM 上下文消失。Prime Agent 的 session tree 依赖 daemon + persistent kernel + 完整历史 JSONL，这三样基础设施我们都没有，且引入成本太高（需要进程管理/daemon 管理/kernel 安全隔离）。
- "执行上下文摘要（execution_context）+ 恢复时注入"是我们的轻量替代——用既有机制（任务池/分选器/派发）实现"可找回"，而不是再造一套 agent 进程系统。

---

### C. 工具面统一（程序化任务操作语言，类似 PTC）

**立场：支持方向但反对激进一步到位——分两步走，先做"任务操作 DSL"，后评估是否引入 persistent Python。**

**具体机制：**

**第一步（v1，近期）**：在现有工具面之上增加一层"任务操作 DSL"——不是替换，是增强。

1. **`/lab task program <source>` 命令**：agent 可以用一个类似 SQL 的声明式 DSL 表达任务操作意图，例如：
   ```
   /lab task program
   ```
   ```sql
   CLAIM 3 FROM pool WHERE labels MATCH 'memory-maintenance';
   SUBMIT task_abc123 WITH output 'memory:entry_xyz';
   REJECT task_def456 REASON 'missing permission: file_write';
   SEARCH memory ANCHORS 'compiler design' LIMIT 10;
   ```
   这个 DSL 被解析为多个机械操作（claimTopN → submitTask → memory.retrieve），在单个事务/serialized 批次中执行，减少 agent 的 round-trip 次数。

2. **DSL 的定位**：它是机械层的接口语言——生成 DSL 的是 LLM（一次 tool call 表达复杂意图），解析执行 DSL 的是系统代码（不引入 LLM 写代码的自由度）。这是 PTC 精神的"受控版本"——让 agent 可以"编程"，但编程语言是有限的声明式 DSL 而非图灵完备的 Python。

3. **实现面**：
   - 在 `SorterEngine` 上加 `executeProgram(program: string): ProgramResult`——解析 DSL → 执行操作序列 → 返回结果。
   - DSL parser 手写（项目 expr.ts 先例，零新依赖）。
   - 声明式操作序列原子执行（全部成功或全部回滚——利用 SQLite 事务）。

**第二步（未来评估）**：在 DSL 运行稳定 + 沙箱机制成熟后，评估是否引入 persistent Python kernel（类似 Prime Agent 的 IPython）。

**为什么不赞成立即引入 persistent IPython kernel：**
1. **安全边界**：Prime Agent 明确声明 IPython/worker 不是 sandbox——模型生成的代码有当前用户 OS 权限。在我们的场景中，agent 可能有文件写入权限，让 LLM 在 kernel 中自由写 Python 等于给模型 root 访问。
2. **复杂度**：kernel 进程管理、超时、资源限制、隔离都是新基础设施，远超当前 sprint 容量。
3. **治理缺失**：PTC 让 agent 可以做任意程序合成——for/if/async/变量组合——这意味着 agent 的行为空间急剧膨胀。我们还没有行为审计/异常检测机制。
4. **DSL 是审慎的中间态**：声明式 DSL 给 agent 组合能力（batch 操作）、但操作面仍然受限于我们定义的机械操作——可审计、可限制、可回滚。

---

### D. 自改进（经验→固化→下次采用）的机制与边界

**立场：支持在治理框架内实现自改进，但触发/评价/固化必须三方分离，且固化输出只进"草稿区"（需人工或公域审核才生效）。**

**具体机制：**

1. **谁触发（触发器）**：**记忆维护者角色**（自持态六大角色之一）定期运行"模式识别任务"。
   - 触发条件：某类事件连续出现 ≥3 次（如同一个 agent 因同原因 reject 多个任务、同一 skill 被频繁使用、同一类校验失败反复出现）。
   - 触发方式：记忆维护者的定时任务扫描 EventLog + tasks 表的 rejects[] + L3 记忆的 hitCount 统计 → 识别模式 → 生成"改进提案"条目（kind="proposal"，写入记忆系统的草稿区）。

2. **怎么评价（评价器）**：**分析者角色 + 公域审核矩阵**。
   - 分析者消费 proposal 条目 → 评估可行性/风险评估 → 产出评审意见（approve/reject/modify）。
   - 高影响改进（涉及 SSP 修改、技能更新、selector 规则变更）→ 走公域审核链（审核合成规则 + 超时参数与既有审核矩阵一致）。
   - 低影响改进（如记忆条目格式优化建议）→ 分析者可直接 approve。

3. **怎么固化（执行器）**：
   - **记忆条目层面**：proposal 通过审核 → 记忆维护者将其提升为 official 条目（promote 路径，走正常校验链）。
   - **SSP/技能层面**：proposal 通过审核 → 由人类交互专员或 operator 手动执行修改（不自动修改 SSP 或 agent 配置——这是 Prime Agent Factorio 教训的核心防范）。
   - **selector 规则层面**：proposal 通过审核 → 分析者通过 `/lab agent selector` 更新匹配规则（selector 修改有完整审计事件，可回滚）。

4. **防 reward hacking 的核心设计**：
   - **固化输出永远不进正式态自动生效**——必须有人/公域审核闸门。这与 Prime Agent 的 `/refine` 自动生效形成鲜明对比。
   - **修改目标不是"最大化生产效率"，而是"规则内获取最多货币"**——我们的经济目标本身就约束了 agent 不会无边界优化（作弊得到的货币会在验收/审计中被惩罚）。
   - **审核链覆盖所有自动提案**——proposal 条目的 ruleRef 必须是已审核通过的改进规则（meta 审核循环：改进规则本身的修改走 operator 亲审）。
   - **回溯验证**：proposal 中建议的改进如果在后续执行中导致失败（如 reject 率上升）→ 记忆维护者标记该 proposal 为"有害"，记录进记忆系统的 anti-pattern 条目。

5. **边界**：
   - ❌ 不自动修改 agent 的 SSP 或 system prompt。
   - ❌ 不自动创建新的 skill（skill 创建 = 开发者/op 操作）。
   - ❌ 不自动修改经济参数（elo 赛道权重/赏金分配——这是经济域的治理范围）。
   - ✅ 可以自动生成记忆条目（走正常校验链）。
   - ✅ 可以自动提出 selector 规则调整建议（但需审核才生效）。
   - ✅ 可以自动标记 anti-pattern。

**为什么这个方案优于 Prime Agent 的 `/refine`：**
- 我们不是不让 agent 自改进，而是要求改进必须**经过对抗性审核**——这正是联邦设计的核心优势：多角色互相制衡（分析者负责分析、记忆维护者负责识别模式、审核矩阵负责把关）。
- Prime Agent 的问题不是 `/refine` 技术上有 bug，而是**缺少治理层**——一个 agent 的"经验总结"直接生效，没有独立的评价者。我们的方案补上了这一层。

---

### E. 其他重要启发

除 A-D 外，我认为还有以下重要启发：

**E1. append-only JSONL 完整历史 + 程序化重访**

我们的 L1 纸带本质上是 append-only 的消息历史，但缺少"程序化重访"的能力。Prime Agent 的 JSONL 历史保存 + 程序化查询（通过 IPython 读取历史文件做分析）值得借鉴。

**建议**：在记忆维护者角色的工具集中加入"纸带分析"能力——`sdk.memory.scanTape(query)`，允许 agent 正则/关键词搜索自己的历史纸带，提取模式。这不涉及改变纸带的存储格式（仍然是 append-only），只增加读取面。

**E2. 定时器驱动的自主行为（persistent goals/heartbeats/scheduled prompts）**

Prime Agent 的 daemon + persistent goals 赋予了 agent 在没有外部触发时的自主行动能力。我们的联邦中，scheduled_jobs + 摄入周期流已经有了定时触发的基础设施，但缺少"agent 给自己设定目标"的机制。

**建议**：扩展任务模板系统，增加 `selfGoal` 模板类型——agent 通过 `/lab goal set "每 30 分钟扫描记忆库中未审查的新条目"` 给自己注册周期性目标，目标作为 scheduled_job 注册，到期触发分选器派发给该 agent。这填补了"agent 的自主时间线"空白。

**E3. Skills 的可创建性**

Prime Agent 允许 agent 创建 SKILL.md + Python package + helper scripts。我们目前没有 agent 可创建的工具——所有工具都是系统代码定义的。

**建议**：在自持态建设阶段，为"开发者角色"赋予"创建任务模板"的能力（任务模板本质上是我们的"skill"——定义了执行协议+成果契约）。开发者创建新模板 → 走公域审核链 → 审核通过后注册进 task_templates 表。这比"agent 可以写 SKILL.md"更符合我们的治理架构（模板注册有审核闸门，且模板是可审计的声明式规范而非可执行代码）。

---

## 3. 推荐的下一阶段实施顺序

### 第一阶段：基础增强（1-2 周，可并行）

| 优先级 | 事项 | 涉及模块 | 理由 |
|---|---|---|---|
| P0 | **工作记忆 WM（A）** | memory/sdk/agent-lab.db | 解决会话内跨步状态丢失问题，是复杂多步任务（分析者工作模式）的前置依赖。实现轻量（一张表+两个 SDK 方法）。 |
| P0 | **持久在途任务（B 轻量版）** | taskpool/sdk/schema | `execution_context` 列 + `/lab task resume` 命令，给 fire-and-forget 模式增加"可找回"能力，不改变现有派发逻辑。 |

### 第二阶段：治理加固（2-3 周）

| 优先级 | 事项 | 涉及模块 | 理由 |
|---|---|---|---|
| P1 | **自改进治理框架（D）** | memory/taskpool/assembly | 记忆维护者 + proposal 条目 + 审核矩阵接线。在让 agent 能自改进之前，先把治理闸门建好。 |
| P1 | **纸带分析能力（E1）** | memory/sdk | `scanTape` 方法和记忆维护者的纸带分析工具集。依赖 L1 纸带的既有存储。 |
| P2 | **自主目标机制（E2）** | taskpool/scheduler | `selfGoal` 模板 + scheduled_jobs 接线。agent 的"自主时间线"。 |

### 第三阶段：工具面演进（3-4 周）

| 优先级 | 事项 | 涉及模块 | 理由 |
|---|---|---|---|
| P2 | **任务操作 DSL（C 第一步）** | taskpool/commands | 批量化 task 操作。降低 agent round-trip。依赖第一阶段的基础稳定。 |
| P3 | **开发者角色 + 模板创建（E3）** | taskpool/assembly | agent 可创建新任务模板（走审核链）。依赖自持态角色建造（分析者/开发者/验收者就位）。 |

### 第四阶段：评估与决策

| 事项 | 触发条件 |
|---|---|
| **Persistent Python kernel 评估（C 第二步）** | DSL 运行 1 个月 + 审计事件数据充分 + 沙箱方案成熟 |
| **完整 session tree 评估（B 完整版）** | 持久在途使用率 > 复杂任务量的 30% + 多个 agent 出现"子任务组合"需求 |

### 为什么这个顺序？

1. **WM 是第一优先级**，因为它解决的是"agent 在自己的会话内就丢失信息"的基础问题——这个问题现在就存在，不需要等任何其他模块。
2. **治理先于能力**——我们完全可以在自改进机制上线之前，先建好 proposal → 审核 → 固化的管道，但不接通"自动生成 proposal"的那一端。管道提供可见性和可审计性，等信任度建立后再打开自动化。
3. **DSL 是审慎的中间态**——在跳到 persistent Python 之前，DSL 让我们验证"agent 能有效利用批量化操作"这个假设，同时保持操作面的可控性。
4. **完整 session tree 是最远期的选项**——我们的 fire-and-forget + 轻量持久化大概率覆盖 80% 场景。完整 session tree 的投入产出比需要在实践中验证。

---

## 4. 风险与反对意见（自己设计的弱点）

### 风险 1：WM 可能侵蚀 L2/L3 的边界

WM 如果使用不当，agent 可能把本该沉淀到 L3 的持久记忆（如"经验总结""重要发现"）全部放进 WM，导致会话结束后知识丢失。缓解：WM 的 DSP 注入是可选的——不注入的 key 只在 agent 自己意识里，鼓励 agent 把长期价值的内容显式沉淀；同时记忆维护者可以扫描 WM 使用模式，对"长期不沉淀但反复读写的 key"发出提醒。

### 风险 2：DSL 的"受控性"可能是幻觉

DSL 确实限制了 agent 不能写图灵完备的代码，但声明式操作序列（如 "CLAIM 3"+"SUBMIT all"）本身可能产生复杂交互——比如认领了 3 个任务但只能完成 2 个，第三个需要 reject，DSL 中的原子性（全部成功或回滚）可能与实际情况冲突。缓解：DSL 支持条件分支（WHEN...THEN...ELSE）或让原子性范围可配置（PER_TASK vs ALL_OR_NOTHING）。

### 风险 3：自改进的 proposal 质量可能很低

LLM 产出的"模式识别"可能产生大量噪声 proposal（伪模式、过拟合），审核矩阵被垃圾 proposal 淹没。缓解：proposal 生成前有最小信号阈值（连续出现 ≥3 次且有统计显著性）；分析者可以对 proposal 打"噪声"标签，连续被打标签的 proposal 源（特定 agent/模板）进入冷却期。

### 风险 4：持久在途任务可能产生僵尸任务

如果 agent 会话异常终止且没有被正确标记，`execution_context` 中的任务可能成为僵尸——既不是 pending 也不是 claimed，卡在中间态。缓解：stale 回收机制扩展——不仅回收超时的 claimed 任务，也回收 `execution_context.sessionId` 对应会话已不存在的"孤儿在途"任务。

### 风险 5：整体改动面评估

WM（A）+ 持久在途（B 轻量）+ proposal 管道（D 框架）+ DSL（C 第一步）+ 纸带分析（E1）+ selfGoal（E2），六个事项跨越 memory/taskpool/sdk/scheduler/commands 五大模块，SQLite schema 新增 ≥2 列、≥2 表，新增 SDK 方法 ≥5 个，测试增量显著。如果全量推进，工程容量可能是瓶颈。建议严格执行四阶段分批，单阶段完成+绿+commit 后再进下一阶段。

---

## 5. 与其他可能方案的分歧点预告

### 我预计其他模型会怎么选

**qwen3.8-max（审查/保守倾向）**：
- 很可能对 A（WM）持保守态度——认为 L2 数据域和 L3 语义记忆已经够用，加 WM 会造成三层记忆边界模糊。
- 对 C（PTC/DSL）持强烈反对——认为 DSL 是过度工程，现有分选器+sorter? 端口已经覆盖操作面。
- 对 D（自改进）可能比我更保守——可能主张仅做审计/统计观测，不做任何自动 proposal 生成。
- 预计会强调"工程容量约束"——我们刚刚完成 taskpool 建设，不宜立即开启大改动。

**deepseek-v4-flash（激进/实验倾向）**：
- 可能对 C（PTC）持最强支持——主张直接引入 persistent IPython kernel，跳过 DSL 阶段。
- 对 B（持久 agent 会话）可能比我更激进——主张实现完整 session tree + rlm() 式递归 agent。
- 对 D（自改进）可能主张更开放的自动化——让 agent 可以直接修改自己的 selector 规则和 SSP（而非必须走审核链）。

### 我想争论的点

1. **"治理先于能力" vs "能力驱动治理"**：
   我主张先建治理闸门（审核管道、proposal 草稿区、审计事件）再开自动化能力。如果 deepseek-v4-flash 主张能力先行，我认为这是 Prime Agent Factorio 教训的复现风险——一旦 agent 获得了自修改的能力却没有闸门，纠正代价会比预先建闸门高得多。

2. **DSL 是不是过度工程**：
   如果 qwen3.8-max 主张现有工具面已足够，我想争论的是：当前 agent 做一个"认领 3 个任务→逐个执行→提交/拒绝"的操作，需要 3 次 tool call（claimTopN）+ N 次 submit/reject，每次都是完整的 round-trip（LLM 推理→工具调用→结果返回→下一次推理）。DSL 可以把这个序列压缩为 1 次 tool call。这不仅是效率问题，更是 agent 能做复杂编排的前提——正如 PTC 不只是语法糖，而是范式的改变。

3. **WM 的实际必要性**：
   如果其他模型认为 L2/L3 已覆盖，"不需要"WM，我想强调：分析者角色的核心工作模式——拆分任务→等待子结果→组合决策——在没有跨步状态存储的情况下，要么不断沉淀再检索（L3 过度使用，噪音增加），要么全靠 context window（贵且脆弱）。WM 是"会话内的缓存层"，有明确的 TTL 和边界，不会侵蚀 L3 的长期价值。

4. **持久 agent 会话的边界**：
   我认为"轻量持久化（execution_context + resume）"是正确的第一站，而非 Prime Agent 式的完整 session tree。如果 deepseek-v4-flash 主张完整实现，我想提醒：我们的 agent 没有 daemon、没有 persistent kernel、没有 JSONL 完整历史——完整 session tree 是在沙地上建城堡，而轻量方案利用了已有的任务池/分选器/派发基础设施。

---

## 附录：关键设计裁决记录（备查）

| 裁决 | 内容 |
|---|---|
| WM 定位 | L2.5 层，SQLite 存储，SDK 封装，会话生命周期，不进 L3 版本化/CAS |
| WM→L3 路径 | agent 显式调用 sdk.memory.write()，走正常校验链 |
| 持久在途实现 | tasks.execution_context 列 + /lab task resume，非独立 session tree |
| DSL 定位 | 声明式、机械层解析执行、图灵不完备、原子事务 |
| DSL→PTC 路径 | DSL 运行 1 个月 + 沙箱成熟 → 评估 persistent Python |
| 自改进触发 | 记忆维护者扫描 EventLog + rejects[] + hitCount |
| 自改进评价 | 分析者初评 + 公域审核矩阵（高影响）/ 分析者直接 approve（低影响） |
| 自改进固化 | proposal → official 条目（走 promote），SSP/技能修改由 op 手动执行 |
| 防 reward hacking | 固化输出不自动生效 + 经济目标约束 + 审核闸门 + 回溯验证 anti-pattern |
| 纸带分析 | sdk.memory.scanTape(query)，正则/关键词搜索，读取面不改变存储 |
| 自主目标 | selfGoal 模板 + scheduled_jobs，agent 给自己注册周期性目标 |
| 模板创建 | 开发者角色 + 模板注册 + 公域审核链（非 agent 自由创建 skill） |
