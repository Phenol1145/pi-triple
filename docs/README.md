# Pi-Triple 文档中心

> 双产品：**PTL**（基于 pi 的多环境共存平台）· **PTH**（自耦自然语言解释器）。二者无前后端关联，PTL 可通过 PTH CLI 调用 PTH。

## 快速入口

| 文档 | 内容 |
|------|------|
| [README](../README.md) | 项目总览 + 快速开始 |
| [ARCHITECTURE](../ARCHITECTURE.md) | 架构总览（单一真相源） |

## PTL（Pi-Triple-Lite）

| 文档 | 内容 |
|------|------|
| [PTL 架构](./ptl/architecture.md) | 多环境共存平台 · 双 TUI · tmux 会话 · PTH CLI 调用 |
| [任务提交指南](./ptl/pth-task-submission.md) | PTH CLI / 兼容通道 · 四形态提交 · 生命周期 · 结果取回 · 排障 |
| [PTH 安装与调优](./pth/deployment.md) | compose 拓扑 · 安装步骤 · 性能参数全表 · 调优闭环 · 容器抽象意图 |
| [创作指南](./ptl/authoring.md) | 新建技能/扩展的放置与挂载规范 |

## PTH（Pi-Triple-Heavy）

| 文档 | 内容 |
|------|------|
| [PTH 架构](./pth/architecture.md) | 分层总览 · 框架/实现分离 · 替换与扩展点 |
| [PTH 框架契约](./pth/framework-contracts.md) | 模块边界 · 公共端口 · 依赖矩阵 · 生命周期不变量 · 边界检查规则 |
| [Human Interaction 协议](./pth/n25-human-interaction-protocol-design.md) | 意图多轴模型 · TaskDraft · 可调审核 · 人类等待/恢复 · 输出表达 · adapter 边界 |
| [自主知识摄入设计](./pth/n26-autonomous-knowledge-intake-design.md) | 人类唯一信任源 · 自动发现/抓取/抽取/核验/晋升/重爬 · 十域生产验收 |
| [Role/Memory/Worker 可行性设计](./pth/n28-role-memory-orchestration-design.md) | Role Lineage · WorkerReplica · 重叠记忆责任区 · 分层检索 · 统一认知预算 |
| [Role/Memory/Worker 实施计划](./pth/n28-role-memory-orchestration-implementation-plan.md) | N27 含 R6 的最终报告校正后执行 · 七个可审查任务 · 12 条 gold query · 1,000 组预算探针 · GO/NO-GO 判定 |
| [Human Interaction 边界 ADR](./adr/0005-pth-human-interaction-boundary.md) | PTH 拥有协议和状态 · human-interface 非 batch worker · PTL/UI 为 adapter |
| [v1.2 F1–F5 复验报告](./pth/v1.2-acceptance-fix-revalidation.md) | F1–F5 contracted fixes 已合并；原 Gate A/B/C 仍未关闭 |
| [PTH 配置](./pth/configuration.md) | 107 键 typed schema · ConfigCenter · secrets 文件 · `pth config` 命令 |
| [PTH Trigger 运行时](./pth/trigger-runtime.md) | workflow/loop 扁平化为 trigger 调度指令 · 系统 trigger 目录 · 事件词汇 |
| [W8 任务派发设计](./pth/w8-task-dispatch-design.md) | PTL 入口路由 · delegate/await · 事件驱动回流 · 组织权 |
| [v1.1.3 发布说明](./releases/v1.1.3.md) | 2026-08-18 · W8 任务派发 + 0.16 穿透/收口 + staged 审核流 + batch 健康面 · 1988 用例 |
| [v1.1.2 发布说明](./releases/v1.1.2.md) | 2026-08-17 · 全模块结构专项收账 · 1903 用例 · 门禁证据 |
| [v1.1.1 发布说明](./releases/v1.1.1.md) | 2026-08-17 补丁 · 三条安装路径修复（F1–F17）· 门禁证据 |
| [v1.1.0 发布说明](./releases/v1.1.0.md) | 2026-08-16 发布 · 门禁证据 · 运维变更 |
| [PTH Kernel 体系](./pth/kernel.md) | ★ 任务池 · 多语言 REPL · 记忆闭环 · 监控日志 |
| [PTH API 参考](./pth/api.md) | HTTP/SSE/WebSocket 端点 |
| [PTH 部署指南](./pth/deployment.md) | 本地 + Docker 部署 |
| [Agent 构建体系](./pth/agent-construction.md) | ★ 五层全景 · 组件/配置/构建流程/验证 |
| [任务编排分工](./pth/orchestration.md) | flow（实例级编排）vs trigger（全局事件规则）选择决策 |
| [开发模式](./pth/development.md) | tsx watch 秒级循环 · dev compose |
| [Kernel 更新策略评估](./superpowers/explorations/2026-08-10-pth-kernel-update-strategy.md) | 容器/宿主边界 · A/B 资源实测 · 更新模式 · 镜像构建优化 |

## 设计文档（specs）

### PTH Kernel
| SPEC | 内容 |
|------|------|
| [多语言持久 REPL](../docs/superpowers/specs/2026-08-08-pth-multilang-repl-design.md) | PyKernel/BashKernel 协议 · 230x 性能 · 池化规划 |
| [解释器持久化](../docs/superpowers/specs/2026-08-08-pth-interpreter-persistence-design.md) | pickle 哲学 · 双轨持久化 · refine 管线 |
| [任务链](../docs/superpowers/specs/2026-08-08-pth-task-resolver-design.md) | payload.flow 路由 · 算子 · 条件表达式 |
| [性能计量](../docs/superpowers/specs/2026-08-08-pth-perf-metrics-design.md) | 四层 35+ 指标 · ResourceProvider |
| [日志体系](../docs/superpowers/specs/2026-08-08-pth-logging-design.md) | KernelLogger · 链路 ctx · IPC 转发 |

### 历史架构（2026-08-07）
[Kernel 架构](./superpowers/specs/2026-08-07-pth-kernel-architecture.md) · [执行](./superpowers/specs/2026-08-07-pth-kernel-execution.md) · [解释器](./superpowers/specs/2026-08-07-pth-kernel-interpreters.md) · [存储](./superpowers/specs/2026-08-07-pth-kernel-storage.md) · [框架拆分](./superpowers/specs/2026-08-07-framework-split-design.md)

### PTL 历史
[CLI 模板迁移](./superpowers/specs/2026-08-06-cli-template-migration-design.md) · [信息摄入闭环](./superpowers/specs/2026-08-06-info-ingestion-loop-design.md) · [任务池排序](./superpowers/specs/2026-08-06-task-pool-sorter-design.md) · [agent-lab 打磨](./superpowers/specs/2026-08-06-ptl-agent-lab-polish-design.md)

### 早期（2026-08-01 ~ 08-05）
[通讯/控制合并](./superpowers/specs/2026-08-01-pit-communicate-control-consolidation-design.md) · [更新发布](./superpowers/specs/2026-08-01-pit-update-release-design.md) · [agent 装配](./superpowers/specs/2026-08-02-agent-assembly-design.md) · [记忆系统](./superpowers/specs/2026-08-02-memory-system-design.md) · [工作流运行时](./superpowers/specs/2026-08-02-workflow-runtime-extension-design.md) · [经济体](./superpowers/specs/2026-08-03-economy-layer-design.md) · [容器化](./superpowers/specs/2026-08-05-containerization-architecture-design.md) · [dev 容器](./superpowers/specs/2026-08-05-dev-container-design.md) · [联邦骨架](./superpowers/specs/2026-08-05-federation-skeleton-design.md)

## 实施计划（plans）

[2026-08-08 任务链](./superpowers/plans/2026-08-08-pth-task-chain.md) · [2026-08-08 任务工具](./superpowers/plans/2026-08-08-pth-task-tools.md) · [2026-08-07 发布](./superpowers/plans/2026-08-07-release.md) · [2026-08-07 框架拆分 A/B/C](./superpowers/plans/2026-08-07-framework-split-a.md) · [Kernel 执行](./superpowers/plans/2026-08-07-pth-kernel-execution.md) · [解释器](./superpowers/plans/2026-08-07-pth-kernel-interpreters.md) · [存储](./superpowers/plans/2026-08-07-pth-kernel-storage.md)

## 其他

[SDD 执行 SOP](./superpowers/sdd-execution-sop.md) · [探索记录](./superpowers/explorations/) · [Runbooks](./superpowers/runbooks/) · [调研](./research/)
