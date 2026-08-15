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

## 共享能力

**Runtime Catalog（运行时目录）**:
一个 Host 或 Runner 实例的角色、空间、能力与获准扩展贡献的显式、使用期不可变集合。
_Avoid_: Global registry、singleton configuration

**Knowledge（知识）**:
拥有记忆、检索、提炼与可见性规则的能力。
_Avoid_: Data world、shared store

**Extension Contribution（扩展贡献）**:
模块可加入 Runtime Catalog 的角色、空间、工具、执行适配器或 observer 的获准声明。
_Avoid_: Arbitrary host plugin、unrestricted eval code
