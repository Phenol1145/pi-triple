# PTH / Kernel 设计文档索引

> 更新：2026-08-09
>
> 用途：为维护者提供近期 PTH Kernel 设计文档的阅读入口。
>
> 边界：本页只整理已有文档及当前代码映射，不增加新的架构裁决。

## 先读什么

1. [PTH Kernel 设计综合总览](./2026-08-09-pth-kernel-design-synthesis.md)：当前设计全景、术语、文档关系、实施状态和已知分歧。
2. [PTH Kernel 架构总纲](./2026-08-07-pth-kernel-architecture.md)：Kernel 建立时的基础范式与边界。
3. 按需要进入下表中的专题 SPEC；实验和外部参考仅作为证据阅读。

## 状态图例

文档状态和实施状态是两个维度：

- **已批准 / 已裁决**：设计决策已经形成，不代表全部代码已经落地。
- **部分落地**：当前代码能观察到核心实现，但文档中的后续阶段仍未完成。
- **已落地（核心）**：文档描述的核心骨架已存在；不表示风险、测试和运维项全部关闭。
- **未观察到落地**：在 2026-08-09 的当前代码中没有找到对应主体实现。
- **exploration**：实验记录或外部参考，不是规范性约束。

## 近期 Kernel SPEC

| 主题 | 文档 | 设计状态 | 当前实施状态 | 主要关系 |
|---|---|---|---|---|
| 总体架构 | [Kernel 架构总纲](./2026-08-07-pth-kernel-architecture.md) | 已裁决 | 核心骨架已落地 | 其他 Kernel SPEC 的基础 |
| 解释器持久化 | [Refine / 持久化](./2026-08-08-pth-interpreter-persistence-design.md) | 已裁决 | 部分落地 | 被 REPL、Environment 设计复用 |
| 多语言执行 | [多语言持久 REPL](./2026-08-08-pth-multilang-repl-design.md) | 已裁决 | 本地 per-worker 形态已落地 | 池化归属被 sandbox SPEC 更新 |
| 任务流程 | [TaskResolver](./2026-08-08-pth-task-resolver-design.md) | 已裁决 | 核心骨架已落地 | 与 agent loop、Environment 路由相邻 |
| 性能观测 | [性能计量](./2026-08-08-pth-perf-metrics-design.md) | 已定稿 | 部分落地 | 覆盖 Kernel、任务、Refine、资源 |
| 日志观测 | [日志体系](./2026-08-08-pth-logging-design.md) | 已裁决 | 核心骨架已落地 | 与 batch IPC、各 Kernel 集成 |
| LLM 执行 | [LLM agent 执行](./2026-08-08-pth-llm-agent-execution-design.md) | 已批准 | Phase 1 部分落地 | 复用 REPL、能力和 Refine |
| 隔离执行 | [Kernel sandbox](./2026-08-08-pth-kernel-sandbox-design.md) | 已批准 | 未观察到主体落地 | 更新 REPL 池的目标归属 |
| 环境状态 | [Environment 生命周期](./2026-08-08-pth-environment-lifecycle-design.md) | 已批准 | 未观察到主体落地 | 组合路由、Kernel 状态、快照和 GC |
| 仓库治理 | [仓库拆分](./2026-08-08-repo-split-design.md) | 已批准 | 未执行 | 影响 PTH、PTL、infra 和构建工具归属 |

## Exploration 与实验

| 文档 | 性质 | 使用方式 |
|---|---|---|
| [Prime Agent 对照](../explorations/2026-08-08-prime-agent-reference.md) | 外部参考 | 用于说明 PTC、持久 REPL、分层记忆等概念来源，不覆盖本仓 SPEC |
| [任务池运维实验](../explorations/2026-08-08-taskpool-ops-experiment.md) | 单次实验记录 | 用于理解当时的角色路由、Bash 执行和 PG 环境，不视为通用运维规范 |

## 维护规则

- 新文档应区分“设计状态”和“实施状态”。
- “当前”“已有”“已落地”应尽量注明核对日期或 commit。
- 后续文档改变早期目标时，应写明“更新/取代哪一项”，不删除历史正文。
- exploration 中的性能数字、外部结论和单次实验结果不得自动升级为架构不变量。
- 跨文档仍有分歧的内容统一登记在[综合总览的分歧章节](./2026-08-09-pth-kernel-design-synthesis.md#8-已有文档之间的分歧与未闭合项)。
