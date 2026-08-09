# Pi-Triple 文档中心

> 双产品线：**PTL**（轻量开发/调试工具链）· **PTH**（agent 联邦平台 + 任务内核）。

## 快速入口

| 文档 | 内容 |
|------|------|
| [README](../README.md) | 项目总览 + 快速开始 |
| [ARCHITECTURE](../ARCHITECTURE.md) | 架构总览（单一真相源） |

## PTL（Pi-Triple-Lite）

| 文档 | 内容 |
|------|------|
| [PTL 架构](./ptl/architecture.md) | 双 TUI · tmux 会话 · 交互层 · PTL→PTH 桥 |
| [任务提交指南](./ptl/pth-task-submission.md) | PTL→PTH 四形态提交 · 生命周期 · 结果取回 · 批控 · 排障 |
| [创作指南](./ptl/authoring.md) | 新建技能/扩展的放置与挂载规范 |

## PTH（Pi-Triple-Heavy）

| 文档 | 内容 |
|------|------|
| [PTH 架构](./pth/architecture.md) | 分层架构 · 硬约束 C1-C10 · 扩展方式 |
| [PTH Kernel 体系](./pth/kernel.md) | ★ 任务池 · 多语言 REPL · 记忆闭环 · 监控日志 |
| [PTH API 参考](./pth/api.md) | HTTP/SSE/WebSocket 端点 |
| [PTH 部署指南](./pth/deployment.md) | 本地 + Docker 部署 |

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
