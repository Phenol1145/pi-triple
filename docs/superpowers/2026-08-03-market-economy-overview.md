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
| 0 | ptl-communicate/ptl-control 整合 | ✅ 已合并 | 2026-08-01-ptl-communicate-control-consolidation-design.md | feat/ptl-communicate-control-consolidation |
| 1 | pit 全量更新 + 会话内提示 | ✅ 已合并 + **v0.1.1 已发布** | 2026-08-01-ptl-update-release-design.md | feat/ptl-update-release |
| A | ptl-flow 运行时扩展（code 节点 + metrics） | ✅ 已合并 | 2026-08-02-workflow-runtime-extension-design.md | feat/flow-runtime-extension |
| B | 记忆系统（L3 语义记忆 + 语言体系 + 公域/审核链/通讯） | ✅ 已合并 | 2026-08-02-memory-system-design.md | feat/memory-system |
| C | 装配层（Agent Assembly） | ✅ 已合并 | 2026-08-02-agent-assembly-design.md | feat/agent-assembly |
| D | **经济层**（多货币/汇率/elo/嵌套市场/竞价 workflow 化/货币循环观测） | ✅ **已合并 + 真实 LLM 冒烟跑通**（D1 基础设施 + D2 市场闭环 + D3 硬化 + D4 收敛+冒烟） | 2026-08-03-economy-layer-design.md | feat/economy-*（已合并删除） |

## 规划中子项目（候选——未启动）

| # | 子项目 | 目标 | 前置依赖 |
|---|--------|------|----------|
| E | **联邦引导（Federation Bootstrap）** | 定义启动序列：初始化中央池 → mint 初始货币 → 注册种子任务类型 → 装配 operator/首批 agent → 联邦就绪验证。补齐当前启动状态缺口（池初始化/种子类型/operator 身份/初始货币发行） | D 完成 ✓ |
| F | **容器化迁移（Docker）** | 从单进程本地运行迁移到容器编排（可靠性/隔离/可控）。核心架构决策：共享账本 vs 分布式账本、事件总线选型、每 agent 独立容器 | E（启动状态固化后容器化才有可编排的引导序列） |

> **E→F 顺序约束**：先固化联邦启动状态（E），再容器化（F）——容器编排需要一个确定的引导序列作为各容器的启动入口。

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

### 经济层（D，设计决策已确认 + **已实施 D1-D4**——2026-08-03 brainstorm / 2026-08-04 收官）

- **范围**：完整经济语义一次做（Q1-B）+ 保留优化器（汇率修正/elo K/税率/odds 参数 = tunable）+ **elo 计算抽象化接口**（注册表模式）
- **市场运行时**：**市场即 workflow**（Q2-A）——竞价→执行→结算全流程 = flow.json 图；code 节点 = 选择/结算确定性内核；**嵌套市场 = 子图节点**
- **组织形态**：**组织 = 持久 AgentInstance**（Q3-B）——自己账本/记忆域/决策循环；对外单一出价节点；任务分解 = 临时组织（生命周期特例）。协作群体分层：**经济主体（AgentInstance）× 协作拓扑（workflow）× 合议决策（审核算子）三维度正交**——判别标准 = "需要自己的钱包吗"
- **货币体系**：**信用货币 + 资源凭证分层**（Q4-C）——credit = 唯一流通货币（竞价/结算/税/统一计价）；time/llm/compute = **资源凭证**（锚定物理量；只能用 credit 向中央购买；凭证间不互兑；**凭证耗尽 = 物理停机**；记忆存储 = compute 持续消耗）。汇率语义：已消耗不变 / 持仓物理量不变（credit 计价浮动）/ 新购按新价。**双层记账**（物理量 + credit 历史成本折算；两本账对账 = 价格信号）。汇率结构 = 凭证→物理量固定锚定 + credit→凭证浮动（静态基准 + optimizer 动态修正）
- **中央池**（Q5-A）：税/凭证销售收入 → 池；endowment ← 池；**允许赤字**（不隐藏超发）。odds = 任务属性（发布方风险报价）；结算公式保留线性式 `stake×(O−1)×(2c−1)`；税基 = 正收益部分
- **elo**（Q6-B）：**全局 + 分域**（域无记录回退全局）；对手 = 任务难度分（odds 映射），得分 = 完成度 c，标准 Elo 期望公式，结算驱动更新；组织与个人各自持分。**EloFormula / SelectionFormula 注册表**（默认 score = stake^α × norm(elo)^β，α/β tunable）
- **任务类型注册表**（用户约束）：**信息传递 vs 任务发布制度性分离**（灰色经济不封锁，体制只保障市场内交易的 elo/结算/税收/保护）；任务类型**开放注册**（kind 哲学同构——行业自我生长）；**任务发布强制带已注册类型**（市场拒收未注册类型）；类型注册 = **elo 赛道自动创建**；agent 承接声明 = 进入赛道
- **结算传导**：**垫付制**（Q7-B）——组织垫付结算成员（debit 抛错 = 组织违约事件：成员 stake 退还无收益 + 组织 elo 受损 + 审计可见）；组织利润 = settle_org − Σsettle_member − 税；余额耗尽 = 市场自然出局；成员烧自己凭证（凭证 v1 不可转让）
- **观测与沉淀**（Q8）：货币事件全量进事件流（mint/burn/exchange/consume/transfer/tax/settle）+ 投影报表（发行量/流速 ↔ 物理资源对账）；**结算事件驱动记忆沉淀**（执行经验 + 竞价经验含未中标）

### 经济层实施成果（D1-D4，已合并 + 真实冒烟跑通——2026-08-04）

从 spec（5 轮对抗评审收敛）→ SDD 实施（27 任务）→ 真实 LLM 端到端验证，全链路闭环。规模：**39 commits / 17 economy 模块（3232 行）/ 34 经济测试文件 / 全仓 1636 pass（2 基线失败非本工作引入）**。

**四阶段交付**：

| 阶段 | 核心 | 亮点 |
|---|---|---|
| **D1 基础设施** | 凭证/elo/escrow/中央池/事件/效果幂等/流式节点/子图/双向托管 | 最终 adversary review 抓出协调者 ruling 方向错误并**反转**（幂等记录与 saveState 顺序） |
| **D2 市场闭环** | 市场 fns/结算中位数共识/多评评审轮/校准/组织垫付/观测投影/经验沉淀/C 接线包/runner+bench | **共享事务协调器**（WeakMap 嵌套复用）破解资金守恒；子代理 6 次挂起→协调者接管 Task 4 |
| **D3 硬化** | 经验 ruleRef/resume 凭证幂等/buy_voucher 发射/negativeFlow 硬化 | 行式管道 grammar 对齐记忆语法体系；业务键幂等 |
| **D4 收敛+冒烟** | 双字段收敛/negativeFlow 移除/真实 LLM 冒烟 | **DeepSeek 真实生成 twoSum 进入市场闭环**，8/8 PASS、守恒 Δ=0 |

**核心架构（17 模块，`src/economy/`）**：

- **货币循环**：`voucher-port`（物理锚定凭证 FIFO 成本）+ `central-pool`（池）+ `elo`（双注册表）
- **市场机制**：`market-fns`（announce/shortlist/select）+ `settlement`（中位数共识/评审结算/对称课税/负流不对称/校准锚定）+ `review-round`（互斥/纯 elo 序/流标阶梯）+ `market-effects`（persist/adjust_escrow/apply_settlement）
- **生态角色**：`calibration`（合成执行者/ground truth）+ `org`（垫付先本后息/违约链）+ `experience`（四类经验→记忆沉淀）
- **观测**：`economy-events`（15 类事件流）+ `projections`（发行量/对账/elo 分布/评审准确性/校准偏差榜）
- **引擎**：`market-runner`（§5.1 全链编排 + checkpoint resume）
- **横切**：`escrow`（两阶段+bid 对称冻结）+ `tx-utils`（共享事务协调器）

**关键工程决策（沉淀的方法论）**：

1. **共享事务协调器**：ledger/voucher 各方法内部 BEGIN IMMEDIATE → 经 `withSharedTransaction`（WeakMap\<db\>）外层开内层复用——既保原子性又解嵌套冲突。
2. **效果幂等契约**：崩溃于 saveState 与 appendEffectRecords 之间 → 无记录 → 重执行 at-least-once；fn 按业务键幂等（凭证燃烧 traceId/任务 id/退款 taskId+round）。
3. **资金守恒不变式**：escrow 全额解冻回 publisher→付 gross→收 net 税入池；负 settle 冻结返还+余额扣回+credit 对方——代数可验证。
4. **校准不可辨识**：`isCalibration` 仅系统侧（评审者视角与普通任务同构）；ground truth 评定。
5. **对齐既有体系**：经验沉淀走记忆系统行式管道 grammar（`rule:experience` 7 字段）而非旁路——一致性优先。

**实机验证**：`SMOKE_LLM=1 node --experimental-strip-types extensions/agent-lab/examples/market-smoke.ts`（1 任务闭环，execute 真实 DeepSeek、bid/review 规则桩——最小额度；runbook：`docs/superpowers/runbooks/2026-08-04-market-smoke.md`）。

**实施计划归档**：`plans/2026-08-03-economy-infrastructure.md`（D1）/ `2026-08-04-economy-market-closure.md`（D2）/ `2026-08-04-economy-hardening.md`（D3）/ `2026-08-04-economy-convergence.md`（D4）。

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
- **经济层后续（D5 候选）**：组织资本指引（M-1 双重冻结装配指引）/ 经验沉淀真实消费（agent 学习闭环）/ 扩展冒烟（bid·review LLM、组织·校准场景）/ PTL 生产 spawnAgent 接线
- **D2 遗留**：elo 域完整化 / spawnAgent body 语义 / 重投更新语义

## 执行方法论（已验证有效的模式）

- **brainstorming**：一次一个问题（questionnaire），决策点逐个确认
- **spec 对抗性评审**：kimi-coding/k3-256k（用户信任模型）× 2-3 轮 → 收敛后写计划
- **SDD 实施**：逐任务 fresh-context worker（deepseek-v4-flash 实施 + reviewer-lite 审查）+ 协调者裁决（rulings 传递）+ 最终 whole-branch review（REQUEST CHANGES → fix wave → re-review → 合并）
- **约束**：R0 不碰 pi 源码 / 零新增依赖 / agent-lab 内 import `.ts` 后缀 / 测试 node:test / tmp+rename 原子写
