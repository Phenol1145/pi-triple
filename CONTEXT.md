# Pi-Triple（PTL / PTH）

Pi-Triple 由两个互相独立的产品组成：PTL 是基于 pi 的多环境共存平台，PTH 是自耦自然语言解释器。二者之间不存在前端/后端关系；PTL 可以通过 PTH CLI 调用 PTH。本词表记录稳定领域语言，只描述领域概念，不描述目录名或实现选择。

## 产品构成

**PTL**:
基于 pi 的多环境共存平台——多个 pi 环境以模板隔离方式并行共存、切换与管理。
_Avoid_: PTH 前端、交互层、PTH 运维前端

**PTH**:
自耦自然语言解释器——接收自然语言意图并直接产出执行结果（解释即执行）；任务池、角色路由、沙箱只是内部实现机制，不是对外定位。
_Avoid_: 后端、执行层、服务器端任务平台、agent 联邦平台

**PTH CLI**:
PTL（或任何调用方）调用 PTH 的规范接口。
_Avoid_: HTTP 桥（仅作为兼容通道保留）

**PTH Host**:
选择产品 Profile、装配获准模块并拥有其生命周期的进程。
_Avoid_: Core、kernel server、application singleton

**Profile**:
在构建或部署时选定固定 PTH 模块与适配器组合形成的受支持产品形态。
_Avoid_: Fork、edition branch、dynamic plugin set

**Module**:
拥有公开应用 API、自有规则与自有状态的能力边界；模块可在不暴露其 repository 或基础设施对象的情况下内部演进。
_Avoid_: Directory、layer、utility collection

**Adapter**:
针对具体技术或外部进程的模块端口实现。
_Avoid_: Core service、business module

## 解释机制（自耦的内涵）

**自耦（self-coupling）**:
解释与执行在 PTH 内闭环，并通过 agentic JIT 循环、动作空间分化、记忆空间分化等稳定自我优化措施持续自我改进。
_Avoid_: 自藕（同音误写）、解释与执行分离、前后端调用链

**Agentic JIT 循环**:
自然语言在解释时按需即时进入 agent 循环——理解、生成、执行、反馈在同一循环内闭环。
_Avoid_: 静态计划流水线、先完整规划后执行

**动作空间分化**:
按任务把可执行动作（工具、技能、角色能力）分化为专用动作空间，而不是单一全局动作集。
_Avoid_: 全局工具集、统一动作空间

**记忆空间分化**:
按范围（租户、角色、空间）分化隔离记忆，使不同解释上下文拥有各自的记忆空间。
_Avoid_: 单一共享记忆库、全局记忆

**稳定自我优化**:
通过上述分化与循环，以可观测、可回滚的方式逐步自我优化；优化不得引入不稳定行为。
_Avoid_: 一次性大改、不可逆自动演化

## 任务执行

**Task Control（任务控制）**:
接受、路由、租借、取消并记录任务的权威方；拥有任务状态迁移。
_Avoid_: Kernel、worker pool

**Task Runner（任务运行器）**:
接收已租借任务、协调 agent 工作并返回 outcome 的能力；不拥有任务状态。
_Avoid_: Task control、scheduler

**Execution Runtime（执行运行时）**:
运行获准代码并报告执行结果的语言无关能力。
_Avoid_: Task runtime、sandbox

**Task Lease（任务租约）**:
处理一个已路由任务、限定一个租户与工作区的时限性权限。
_Avoid_: Task ID、worker ownership

**Execution Grant（执行授权）**:
针对单次执行请求的短期单用途权限，绑定任务租约、租户、工作区、能力与截止时间。
_Avoid_: Shared sandbox secret、kernel ID

## 人机交互

**Human Interaction（人机交互）**:
PTH 中解释用户输入、形成可确认任务意图，并在执行需要人类参与时维持连续交互的领域边界。
_Avoid_: PTL 前端、聊天 UI、Workflow approval

**human-interface（交互角色）**:
提出结构化意图与任务稿件、调整用户可见表达的按需语义角色；它不拥有权威状态，也不是任务池 worker。
_Avoid_: human-interface worker、审批状态机、用户本人

**Interaction Channel Adapter（交互通道适配器）**:
把具体界面的输入输出翻译为 Human Interaction 规范协议的边界组件。
_Avoid_: 交互事实源、PTL 专用协议、mailbox 状态机

**Stable Principal（稳定主体）**:
可跨请求唯一标识并由认证系统证明的人或服务身份，是回答、批准和拒绝决定的签发者。
_Avoid_: tenant+role 合成身份、body 自报 actor、显示名

**Interaction Session（交互会话）**:
同一租户与参与者围绕连续语境形成的有序 Turn 容器。
_Avoid_: AgentEngine Session、Task、Workflow run

**Turn（交互轮次）**:
Interaction Session 中一条不可变、有顺序且标明说话主体的输入或输出。
_Avoid_: Session、Human Request、可原地修改的消息

**Resolved Intent（已解析意图）**:
经服务器约束校验后可用于选择讨论、成稿或控制动作的权威意图判定。
_Avoid_: LLM 分类文本、Intent Proposal、关键词标签

**Task Draft（任务稿件）**:
由一个或多个 Turn 编译出的、可版本化审核并可生成任务提交的工作承诺。
_Avoid_: Task、prompt、聊天摘要

**Effect Assessment（影响评估）**:
根据任务将调用的能力计算出的作用范围、可逆性与风险组合。
_Avoid_: LLM 自报风险、Review Decision、单一 risk score

**Review Policy（审核策略）**:
决定某一 Task Draft 是否自动提交、展示确认、澄清或升级审核的版本化规则。
_Avoid_: Safety floor、UI 展示偏好、一次性确认

**Human Request（人类请求）**:
执行过程中向指定人类主体或群体提出的、可回答或可裁决的持久交互要求。
_Avoid_: fallback_request、子任务、普通聊天消息

**Human Response（人类响应）**:
稳定主体针对特定 Human Request 版本提交的不可变回答或选择。
_Avoid_: TaskOutcome、mailbox message、未认证文本

**Approval Decision（批准决定）**:
Human Response 中对特定目标 revision 作出的批准、拒绝或取消裁决。
_Avoid_: TaskOutcome、role verdict、未绑定 revision 的同意

## 共享能力

**Runtime Catalog（运行时目录）**:
一个 Host 或 Runner 实例的角色、空间、能力与获准扩展贡献的显式、使用期不可变集合。
_Avoid_: Global registry、singleton configuration

**Knowledge（知识）**:
拥有记忆、检索、提炼与可见性规则的能力。
_Avoid_: Data world、shared store

**Knowledge Intake（知识摄入）**:
PTH Knowledge 内将人类获准来源自动转化为不可变来源修订与可核验知识候选的领域能力。
_Avoid_: 顶层 Intake Module、crawler、抓取工具、直接官方晋升

**Trust Policy（信任策略）**:
由人类签发、绑定租户/空间并版本化的来源准入规则，是 PTH 授予来源范围、许可与抓取预算信任的唯一事实源。
_Avoid_: LLM 推荐、搜索排名、worker 自报权威、逐条事实真值

**Knowledge Source（知识来源）**:
受租户、空间、来源类型、许可与刷新策略约束的逻辑信息源。
_Avoid_: 单次 HTTP 响应、Discipline Catalog、pilot fixture

**Source Candidate（来源候选）**:
由 LLM、搜索或角色推荐但尚未获得 Trust Policy 准入的潜在知识来源。
_Avoid_: 受信来源、Source Subscription、官方证据

**Source Subscription（来源订阅）**:
经 Trust Policy 匹配后可在获准范围与预算内持续抓取的逻辑来源登记。
_Avoid_: Trigger、定时任务、单次抓取

**Intake Run（摄入运行）**:
针对一个 Source Subscription 的一次持久、幂等、可租借并可恢复的摄入尝试。
_Avoid_: Task、worker session、Trigger fire

**Source Revision（来源修订）**:
一次来源获取形成的不可变事实记录，绑定实际响应、artifact hash、解析版本与当时的信任决定。
_Avoid_: 当前网页、可覆盖快照、registry fingerprint

**Evidence Reference（证据引用）**:
从知识声明精确指向 Source Revision 中特定 representation 与 locator 的结构化、可重放引用。
_Avoid_: 自由文本 URL、无版本 sourceRefs、LLM 自报摘录

**Knowledge Candidate（知识候选）**:
带来源证据但尚未完成核验与晋升的 draft 知识提议。
_Avoid_: official knowledge、搜索结果、未经证据绑定的摘要

**Extension Contribution（扩展贡献）**:
模块可加入 Runtime Catalog 的角色、空间、工具、执行适配器或 observer 的获准声明。
_Avoid_: Arbitrary host plugin、unrestricted eval code
