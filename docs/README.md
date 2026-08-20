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
| [最小可信知识摄入内环反馈与实施计划](./pth/n29-minimal-knowledge-intake-loop-feedback-plan.md) | 双环复验 NO-GO · 本轮单信源 M0 · Task/outbox 前置修复 · 初次摄入/不变重爬/变化重爬验收 |
| [最小可信摄入内环验收报告](./pth/n29-minimal-intake-report.md) | 最终权威版 **MIN_INNER_LOOP_GO** · `c6d0156` · P0-1~P0-9/P1-1~P1-3 全修 · 31 sentinel exact 覆盖 · G8-b 三阶段 SIGKILL + G10 五项 sabotage 全 satisfied |
| [最小可信摄入内环 envelope](./pth/n29-minimal-intake-acceptance.json) | 唯一权威 envelope **MIN_INNER_LOOP_GO**（focused 361 零 skip/build/lint/三 typecheck/full 2615+9 冻结 skip 全绿 · 六项 realism gates 全 satisfied）· 绑定 `c6d0156` |
| [最小可信摄入内环再次验收反馈](./pth/n29-minimal-intake-reacceptance-feedback.md) | 当前 HEAD 独立复核 **NOT ACCEPTED / NO-GO** · 跨租户 outbox · stage CAS / Trust Policy / admission / official 旁路 · 修复顺序与复验条件 |
| [统一运行观测台设计](./pth/n30-runtime-observatory-design.md) | C 方案 · Job/Task/Intake 甘特图 · CPU/RSS/Heap/Network 同轴折线 · Freshness Contract · O0–O5 分层交付 |
| [N30 运行观测台验收报告](./pth/n30-runtime-observatory-report.md) | 权威版 **GO** · `c3a2e5a` · focused 104/0 · full 3010/0/9 · 三 realism gates 全 satisfied |
| [N30 运行观测台 envelope](./pth/n30-runtime-observatory-envelope.json) | 唯一权威 envelope **GO** · reasons=0 · 绑定 `c3a2e5a` |
| [v1.3 PTL 五页操作台设计](./pth/n33-v13-ptl-operator-console-design.md) | 总览/运行/调试/记忆/配置 · N30 只读观测面 · 三 WorkMode 原生命令 · 浏览器与服务凭据隔离 |
| [PTL 五页操作台再次验收反馈](./pth/n33-operator-console-reacceptance-feedback.md) | 历史独立复核 **NOT ACCEPTED / NO-GO**（P0/P1 已全部关闭）· 模块图 401 · 上游错误泄露 · DTO 错位 · Task 幂等旁路 · 修复与复验条件 |
| [N33 五页操作台验收报告](./pth/n33-operator-console-report.md) | 权威版 **GO** · `16475b0` · focused 172/0 · full 3016/0/9 · 4 P0 + 4 P1 全关闭 |
| [N33 五页操作台 envelope](./pth/n33-operator-console-envelope.json) | 唯一权威 envelope **GO** · reasons=0 · 绑定 `16475b0` |
| [v1.3 专业计算角色与可执行教程设计](./pth/n32-v13-professional-computing-design.md) | intake/optimize/run · Assembly / Computational Chemistry / Lean 4 / Wolfram · technical-educator · 五类共享记忆 · Jupyter · N30 联动 |
| [v1.3 专业计算实施计划](./superpowers/plans/2026-08-19-v13-professional-computing.md) | Index Memory → 统一专业适配器 → 四类真实垂直切片 → Notebook → 权威验收 |
| [N30 运行观测台实施计划](./superpowers/plans/2026-08-19-n30-runtime-observatory.md) | O0–O4 · 只读时间线 · 有界采样 · SSE reconcile · 甘特/折线联动 |
| [v1.3 PTL 五页操作台实施计划](./superpowers/plans/2026-08-19-v13-ptl-operator-console.md) | 安全本机壳 → N30 总览 → 有界 Worker/Memory/Config/Role 读面 → 三 mode 原生命令 → 浏览器权威门 |
| [v1.3 专业计算权威验收报告](./pth/v13-professional-computing-report.md) | 权威版 **GO** · `cf8615c` · focused 82/0 · full 3053/0/9 · 12 项 sabotage 全翻转 |
| [v1.3 专业计算 envelope](./pth/v13-professional-computing-envelope.json) | 唯一权威 envelope **GO** · reasons=0 · 绑定 `cf8615c` · N29/N30/N33 全 GO |
| [模块化与复用率审计](./pth/modularity-reuse-audit.md) | 483 生产文件/93.8K LOC · 无循环依赖 · 生产重复率 0.01% · 测试重复收敛建议 |
| [统一 Workflow DAG 薄腰设计](./pth/n31-unified-workflow-dag-design.md) | **2.0 目标架构** · 1.x 只做真实设施验证 · 构造约束锁定不可变/可变边界 · 原生执行器保持分立 |
| [Role/Memory/Worker 可行性设计](./pth/n28-role-memory-orchestration-design.md) | Role Lineage · WorkerReplica · 重叠记忆责任区 · 分层检索 · 统一认知预算 |
| [Role/Memory/Worker 实施计划](./pth/n28-role-memory-orchestration-implementation-plan.md) | N27 含 R6 的最终报告校正后执行 · 七个可审查任务 · 12 条 gold query · 1,000 组预算探针 · GO/NO-GO 判定 |
| [Role/Memory/Worker 可行性报告](./pth/n28-feasibility-report.md) | **GO** · 第二轮复核修复后权威版 · `7e76180` · H1–H6 全 PASS · 四门禁全绿 · 合同 v1.1 人工批准 |
| [Role/Memory/Worker 权威验收 envelope](./pth/n28-feasibility-envelope.json) | 完整门禁证据（evaluator byte-identical GO · focused/typecheck/full/lint）· 绑定 `7e76180` |
| [Role/Memory/Worker 可行性验收复核](./pth/n28-feasibility-acceptance-review.md) | 历史复核 **NOT ACCEPTED / NO-GO**（修复前）· 预算绕过与生产接线阻断 · 修复顺序与重新验收条件 |
| [Role/Memory/Worker 再验收反馈](./pth/n28-feasibility-reacceptance-feedback.md) | 当前自动门禁 GO；独立复核 **NOT ACCEPTED / NO-GO** · Worker/Directory 身份错配 · 重复 ID 预算绕过 · evaluator 假绿 |
| [Human Interaction 边界 ADR](./adr/0005-pth-human-interaction-boundary.md) | PTH 拥有协议和状态 · human-interface 非 batch worker · PTL/UI 为 adapter |
| [human-interface 角色迁移 ADR](./adr/0006-ptl-human-interface-role-boundary.md) | 修订 ADR-0005 · 协议/状态仍归 PTH · 高交互语义角色与展示成稿职责归 PTL |
| [v1.2 F1–F5 复验报告](./pth/v1.2-acceptance-fix-revalidation.md) | F1–F5 contracted fixes 已合并；原 Gate A/B/C 仍未关闭 |
| [PTH 配置](./pth/configuration.md) | 107 键 typed schema · ConfigCenter · secrets 文件 · `pth config` 命令 |
| [PTH Trigger 运行时](./pth/trigger-runtime.md) | workflow/loop 扁平化为 trigger 调度指令 · 系统 trigger 目录 · 事件词汇 |
| [W8 任务派发设计](./pth/w8-task-dispatch-design.md) | PTL 入口路由 · delegate/await · 事件驱动回流 · 组织权 |
| [v1.2.0 发布说明](./releases/v1.2.0.md) | 2026-08-19 · **N29 最小可信知识摄入内环 MIN_INNER_LOOP_GO** + N28 二轮复核 GO · 2624 用例 |
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
