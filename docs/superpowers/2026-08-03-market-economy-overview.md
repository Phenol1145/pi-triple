# 市场经济体制：全景路线图与决策记录

> 本文档是 agent-lab「市场经济体制」演进的**父文档**——记录愿景、总原则、子项目路线图与已确认的跨子项目设计决策。各子项目的详细设计见 `docs/superpowers/specs/` 对应 spec；实施计划见 `docs/superpowers/plans/`。

## 愿景

**Agent = 经济主体**：长期存活、自主积累记忆/资本/信誉的图灵机形态实体。
**市场经济体制**：agent 以竞价（market）机制参与任务分工，货币循环驱动资源分配与演化。
**组织**：agent 的经济组织——嵌套市场树（任务分解子市场 ∪ 组织子市场），非生物形态。

## 总原则（所有子项目的共同约束）

1. **语义可迁移**：所有记忆/语义可从一个框架迁移到另一个框架（EBNF 文法 + kind 系统为底座）
2. **知识可压缩**：agent 能自己形成知识（知识压缩 = 把经验凝练成条目；外部模型越强压缩越强）
3. **最优子结构**：agent 嵌套组织（组织的记忆∪成员记忆、组织的账本嵌套）
4. **记忆传承**：agent 之间有记忆交换/遗传（fork 合并——社会层面 = 知识市场）
5. **税收与监管**：operator = 政府（法律/货币/税收/监管），货币发行与回收形成循环
6. **经济计量**：货币的发行与回收要与真实资源对应（token/时间/存储/上下文）

## 子项目路线图

| # | 子项目 | 状态 | spec | 分支 |
|---|--------|------|------|------|
| 0 | pit-communicate/pit-control 整合 | ✅ 已合并 | 2026-08-01-pit-communicate-control-consolidation-design.md | feat/pit-communicate-control-consolidation |
| 1 | pit 全量更新 + 会话内提示 | ✅ 已合并 + **v0.1.1 已发布** | 2026-08-01-pit-update-release-design.md | feat/pit-update-release |
| A | pit-flow 运行时扩展（code 节点 + metrics） | ✅ 已合并 | 2026-08-02-workflow-runtime-extension-design.md | feat/flow-runtime-extension |
| B | 记忆系统（L3 语义记忆 + 语言体系 + 公域/审核链/通讯） | ✅ 已合并 | 2026-08-02-memory-system-design.md | feat/memory-system |
| C | 装配层（Agent Assembly） | ✅ 已合并 | 2026-08-02-agent-assembly-design.md | feat/agent-assembly |
| D | **经济层**（多货币/汇率/elo/嵌套市场/竞价 workflow 化/货币循环观测） | 设计启动 | （待写） | （待建） |

## 已确认设计决策（跨子项目）

### 记忆系统（B，已实施）

- 三层记忆：L1 纸带（append-only + 时间索引）/ L2 数据域 / L3 语义记忆
- 统一不变量：LLM = 无状态读写头；**L2/L3 进可见层唯一通道 = 投影（DSP）**；通讯与用户消息 = 纸带 user 通道（不冒充记忆）
- MemoryEntry 五不变量：原子性（约定级）/ 不可再分 / 版本化（content 不可变）/ 溯源数组 / 锚点非空（`anchor: <text>`）；热字段（hitCount）旁路分离
- kind 开放注册（`kind:<id>`）；axiom 唯一（自我指涉）+ rule/fact/experience/preference 内置；参数无单位
- 语言体系四层：L0 语义 / L1 EBNF 语法（fenced 围栏转交）/ L2 方言（JSON/XML 确定性 + markdown draft-only + 自然语言永不承诺）/ L3 语义约束；LLM 读取只看语义
- SSP = AGENT.md 固定协议；DSP = 每轮重建（记忆入口区 + 工具列表区 + 投影区）
- 检索快照进 checkpoint（实时 4KB / 恢复 16KB）
- 公域 fork-merge（发轫自由 merge 审核）+ 审核链（组合矩阵 + quorum + operator 一票否决；结果仅审计事件表）
- 通讯 = 纸带交换（msgId 幂等；auto mode；4KB 上限）

### 装配层（C，已实施）

- AgentRuntime = 新类（独立继承体系，不继承既有 AgentImpl）
- 记忆域：fresh = 最小记忆合集（公理+基础规则+空私域）；fork = 最小合集 + 源私域整库拷贝
- 装配原子性（attempt-local）：失败回滚本次副作用；记忆域失败不取消既有账户（解耦语义差异）
- 续跑幂等：oracle = 注册记录预检；开户 = created 标记；记忆域残留保守保留
- 规则链 = 公域 kind=rule 只读视图 + 私域解析/公理；规则唯一解析依赖 = 公域（fallback 链）
- 规则冲突 = 装配时审核（默认值候补）+ 发轫时审核；参数调整 = 规则版本更新（审核等同修改）
- LedgerPort 抽象 + SqliteLedger 默认；debit 余额预检抛错（钱 fail-fast）

### 经济层（D，已确认方向——细节待定）

- **多货币**：credit（底层信任）+ time/llm/compute 次级货币；**记忆并入 compute 计价**（不占独立货币位）；持久 agent 持有多种货币
- **汇率**：静态基准表 + 动态修正系数（optimizer tunable）；初期静态，遥测累积后动态
- **持有形态**：混合（日常自动折算 + 可预购囤积）
- **发行**：endowment（中央）+ 结算内生；**回收**：税 + 汇率差
- **嵌套市场**：任务分解子市场 ∪ 组织子市场，结算层级传导
- **选择标准** = f(stake, elo)；elo = 可信度（L2 数据域，结算驱动更新）
- **竞价 = workflow 编排 + code 节点确定性内核**（子项目 A 基础设施已交付）
- **货币循环观测**：发行量/流通频率 ↔ 真实资源（进程/耗时/token/存储）

## D 接线包（C 移交 + 最终评审 rulings）

1. **attachSdk 真实钩子**：runner buildSDK 私有 → 需要 runner sdk 扩展钩子（将真实 MemoryHost 挂到每轮 run 的 sdk.memory）
2. **seqProvider 注入**：assembler 构造 MemoryHost 传 `() => runner.currentSeqOf(agentId)`（契约 ① 生产接线）
3. **⑦ snapshot 生产者注册**：`runner.onCheckpoint(({seq}) => host.dsp.snapshot(seq))`
4. **⑥ inbox 纸带注入**：`bridge.drainInto(seq)` 片段在 `run({task})` 前拼接
5. **delivery=auto 强制**（装配 workloop 绑定时覆写）+ **IdentityMap 装配注册**（⑨）
6. **DSP 两段拼接**：DspBuilder 接提示词路径前必须完成（私域段 + 公域段——否则公域内容对 agent 永不可见）
7. **AssembleOptions 增 agentId/幂等句柄**：恢复 §2.4 崩溃续跑语义（生产可达）
8. **removeAccount 提进 LedgerPort 接口** + startSweeper `timer.unref()` 一行修复

## 债务清单

- 2 pre-existing failures：`weighted-scorer-bootstrap.test.ts`（tests 3/3b，全程基线，与各分支无关）
- 目录规整（D 完成后统一）：`optimizer/` vs `optimizers/`、`scheduler/` vs `schedulers/`、`workloop/` vs `workloops/`（框架 vs 实现的命名重复，语义不同但易混）；`store/`（2 文件）、`experiment/`（1 文件）小目录
- pth 2 unhandled errors（历史性，pre-existing）
- N-I9 迁移已落地（memory_spec/endowment 列）——**PTH 服务真实 repository 消费路径需验证**（D 或独立任务）

## 执行方法论（已验证有效的模式）

- **brainstorming**：一次一个问题（questionnaire），决策点逐个确认
- **spec 对抗性评审**：kimi-coding/k3-256k（用户信任模型）× 2-3 轮 → 收敛后写计划
- **SDD 实施**：逐任务 fresh-context worker（deepseek-v4-flash 实施 + reviewer-lite 审查）+ 协调者裁决（rulings 传递）+ 最终 whole-branch review（REQUEST CHANGES → fix wave → re-review → 合并）
- **约束**：R0 不碰 pi 源码 / 零新增依赖 / agent-lab 内 import `.ts` 后缀 / 测试 node:test / tmp+rename 原子写
