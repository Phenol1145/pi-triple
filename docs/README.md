# Pi-Triple 文档中心

> 双产品：**PTL**（pi 环境管理工具，宿主机 CLI）· **PTH**（Agent 协作与自优化系统）。
> 分类规则与全部 247 份文档清单见 [docs-manifest.json](./docs-manifest.json)；代码运行位置规划见 [code-organization-plan.md](./code-organization-plan.md)。

## 快速入口

| 文档 | 内容 |
|------|------|
| [README](../README.md) | 项目总览 + Quick Start（PTL 30 秒 / PTH `pth up`） |
| [ARCHITECTURE](../ARCHITECTURE.md) | 架构总览 |
| [产品形态](./product-shape.md) | PTL/PTH 定位、入口、双引擎、部署与交互策略（决策基线） |

## PTL（宿主机执行）

| 文档 | 内容 |
|------|------|
| [PTL 架构](./ptl/architecture.md) | 多环境共存平台 · CLI/TUI/tmux · 会话管理 |
| [使用指南](./ptl/pth-usage.md) | ptl 命令面与使用方式 |
| [开发循环](./ptl/dev-loop.md) | PTL 开发模式 |
| [创作指南](./ptl/authoring.md) | 新建技能/扩展的放置与挂载规范 |
| [PTH 任务提交](./ptl/pth-task-submission.md) | PTL → PTH 提交任务的完整契约 |

## PTH（双栖：容器生产 / 宿主机试运行）

### 上手与运维

| 文档 | 内容 |
|------|------|
| [部署指南](./pth/deployment.md) | `pth init/up/down/status/logs` + compose 拓扑 + 性能调优 |
| [开发模式](./pth/development.md) | dev compose · tsx watch 秒级循环 |
| [配置](./pth/configuration.md) | PTH_* 配置 schema · secrets · `pth config` |
| [PTH API](./pth/api.md) | HTTP/SSE/WebSocket 端点 |
| [沙箱安全运维](./pth/sandbox-security-operations.md) | sandbox 隔离与安全检查 |

### 核心架构

| 文档 | 内容 |
|------|------|
| [PTH 架构](./pth/architecture.md) | 分层总览 · 框架/实现分离 |
| [PTH Kernel](./pth/kernel.md) | 任务池 · REPL kernel · batch · 记忆闭环 |
| [框架契约](./pth/framework-contracts.md) | 模块边界 · 公共端口 · 依赖矩阵 |
| [模块归属与产品边界](./pth/module-ownership.md) | PTL/PTH 目录归属与 import 规则 |
| [概念总览](./pth/concepts.md) | 全域概念索引 |
| [Agent 构建](./pth/agent-construction.md) | 组件/配置/构建流程 |
| [任务编排](./pth/orchestration.md) | flow vs trigger 选择决策 |
| [Trigger 运行时](./pth/trigger-runtime.md) | 调度指令与事件词汇 |

### 协议（机器可读）

| 文档 | 内容 |
|------|------|
| [PTH API 协议](./pth/pth-api-protocol.md) | `/api/v1/*` 版本与错误契约 |
| [PTH Console 协议](./pth/console-protocol.md) | Console API v1 |
| [容器运行时适配器协议](./pth/container-runtime-adapter-protocol.md) | ContainerRuntimeAdapter / 选择协议 / lock |
| [PTH Console OpenAPI](./pth/pth-console-openapi.json) | 机器可读路由规范 |

### 设计 / 合同 / 报告

当前与历史设计、任务合同、验收报告、权威 envelope 已分类收录在
[docs-manifest.json](./docs-manifest.json)（`designs` / `contracts` / `reports` / `envelopes`），
核心索引：

- [Human Interaction 协议](./pth/n25-human-interaction-protocol-design.md)
- [统一运行观测台设计](./pth/n30-runtime-observatory-design.md)
- [v1.3 专业计算设计](./pth/n32-v13-professional-computing-design.md)
- [PTL/PTH 仓库拆分设计](./pth/repo-split-v15-design.md)
- [v1.4 Operator Console UX 报告](./pth/v14-operator-console-ux-report.md)
- [最近发布说明](./releases/)

## 决策与工作台

| 目录 | 内容 | 状态 |
|------|------|------|
| [ADR](./adr/) | 架构决策记录（当前有效） | active |
| [superpowers/plans](./superpowers/plans/) | 历史实施计划 | 已归档 |
| [superpowers/specs](./superpowers/specs/) | 历史设计 spec | 已归档 |
| [superpowers/explorations](./superpowers/explorations/) | 调研/探索记录 | 已归档 |
| [superpowers/runbooks](./superpowers/runbooks/) | 运行手册 | 按需查阅 |
| [research](./research/) | 外部调研 | 已归档 |

> 认知规则：日常只看“快速入口 / PTL / PTH 上手与核心架构 / 协议”；任务级设计与历史证据通过 manifest 检索；`superpowers` 与 `releases` 不进入日常阅读路径。
