# TODO（2026-08-15 对齐真实进度）

> 未执行方案的统一入口与执行顺序见 [剩余工作总控计划](./docs/superpowers/plans/2026-08-15-remaining-work-program.md)。

## 批 A：差距 7——obs.container（cgroup 容器级观测源）✅
- [x] obs.ts 加 obs.container（cpu.max/memory.current/pids/usage——容器 cgroup 只读）
- [x] 测试（白名单模板 + 容错——非容器环境降级）
- [x] 容器验证（sandbox/pi-platform 容器内跑通）

## 批 B：差距 11——探索核候选列表（角色定义语言 A/B 并存）✅
- [x] WorkerRole 加 exploreKernels 字段（候选列表——如 ["python","bash"]）
- [x] 角色定义挂候选（reviewer 等）
- [x] agent-loop/task-loop 接线（按候选语言建探索核——A/B 并存 + 探索空间按语言划分）
- [x] 测试（候选解析/回退默认/维度生效）

## 批 C：差距 12——controller/sensor 任务源（trigger 生成观测/控制任务）✅
- [x] trigger-engine 定时生成机制（sensor 观测任务 / controller 控制任务）
- [x] 对接 optimizer 窗口/scorecard
- [x] 测试（定时触发/角色路由/防风暴）

## 批 D：待决点可实现部分 ✅
- [x] 振荡防护：死区（小偏差不动作）+ 增益上限 + 回滚记录
- [x] deopt 语义：记入 maxAttempts 后人工确认（自动回滚基线 + 记录）
- [x] 子 worker 创建入口：refiner 分化提案 → controller:worker-opt 批准通道（对接 lineage approve）

## 批 E：扩展库补充（toolstore/extensions 实用扩展）✅
- [x] git 助手扩展（repo status/diff/log——developer 高频）
- [x] web 检索扩展（http get 文档/页面检索）
- [x] sql 只读查询扩展（白名单表）
- [x] 测试 + 容器装载验证

## 多平台汇编 dev 核（2026-08-12 提议）✅ 已完成（2026-08-12 当日闭环）
> 本段此前未勾选——已按提交记录对齐：`597cb26`（生产核 + 探索核）、`e4f97a5`（Jupyter 适配器）。

- [x] 派发 planner：汇编核设计（生产核 qemu 工具链 + 探索核模拟器 + dev 空间接线——planner 任务 `e899a08b`，监督审阅批准）
- [x] 审设计 + 裁决
- [x] 派发 developer：实现（`597cb26`——asm-kernel 951 行 + rv32i-sim 704 行 + 21 测试 + 接线补丁）
- [x] 派发 tester：多平台验证 + acceptor 验收（x86_64 / riscv64 交叉 qemu + aarch64 原生直跑，全链路 exit=0）
- [x] 容器工具链安装（qemu-user + binutils-x86_64/riscv64——Dockerfile 构建期安装，运行时无外网实测）+ 验证
- [x] 追加：jupyter-asm 探索核适配器（`e4f97a5`——ipykernel Kernel 子类 + node bridge + kernelspec；jupyter_client 8.9 全协议验证）

## 8/14–8/15 概念账本落地批次（对照 docs/pth/backlog-priority.md）
- [x] A1 PTC 契约类型化 + Seam 解耦（Phase 1–3；遗留：能力索引生成器尚待切掉 prompt-docs 手写散文）
- [x] A2 双 storage 层归并（Phase 1–5）
- [x] B6 空间-角色绑定治理（Phase 1–3）
- [x] B2 复测一等化（独立复测任务 + 证据三通道）
- [x] N12 护栏统一抽象一期（五计数器 → guardrails 注册表 + `PTH_GUARD_*`）
- [x] 概念设计裁决收口：T1–T10（8/14）· W1–W7（8/15）全部裁决
- [x] 角色谱系定型（8/15）：origin + 13 叶子四族（executor/explorer/governor/researcher）；sensor/controller 升为真实类型
- [x] B4-2 已裁 A（8/15）：首批 3 条 seed（developer/scout/memory-keeper）；B4-3 已裁 C（两级检索）
- [x] D2 已裁并落地（8/15 custom）：不豁免治理族——negative-loop 阈值 5→15（`PTH_GUARD_NEGATIVE_LIMIT`）
- [x] B4 / N2 Phase 1（8/15）：四段式 skill 格式（`skill-format.ts`）+ 3 条角色 SOP 种子注入（developer/scout/memory-keeper）
- [x] 模块拆分（8/15）：`packages/pth-memory`（记忆域）· `packages/pth-sandbox`（沙箱域含内核契约/运行时）——见 docs/pth/split-design.md
- [x] B4 / N2 Phase 2–4 → **归位 packages/pth-memory/TODO.md**
- [ ] 核心剩余账本：C1（21 子任务）· D4 · N10（7/28）· N12 二期（D1 已落：护栏进 scorecard）
- [x] 记忆侧账本（B3/B5/N1b/N7）→ **归位 packages/pth-memory/TODO.md**
- [x] 沙箱侧账本（B7/N5 资源环等）→ **归位 packages/pth-sandbox/TODO.md**
- [x] 逐包评估（D 方案，8/15）：E2/N11 保留为**设计储备不排期**；B7/N5 → sandbox TODO；B3/B5/N1b/N7 + B4 Phase 2–4 → memory TODO；主 TODO 不再承载

## 调试用例 worker（2026-08-13 用户提议——自修正闭环的验证环节）✅（2026-08-15 P3.6 落）
- 角色：debug-case-writer（parent=tester 分化——测试族内特化；tags debug-case/regression-case/boundary-case）
- 职责：给定 bug 报告/复现步骤/修复 diff——产出 ① 最小复现用例（触发 bug 的条件序列）
  ② 回归测试（vitest——防复发）③ 边界用例（相关边界的探索）
- 在自修正闭环的位置：sensor 检测 → developer 定位/修复 → 【debug-case-writer 生成用例】
  → 全量验证 → 部署提案
- 触发：controller 裁决批准修复后（`manage.fix.approve` 治理面通道）；developer 修复完成自动派发
  （task-loop 完成点——`payload.debugCases="off"` 可关）
- 验收：生成的用例能复现修复前 bug（修复前 FAIL）+ 修复后 PASS（done.result 契约 repro/regression/boundary/verification）

## LLM→工具调用→执行核 链路筛查遗留（2026-08-15，报告见 docs/superpowers/explorations/2026-08-15-llm-call-chain-audit.md）
**核心侧（留主 TODO）**：
- [x] HIGH：ts-interpreter 尾表达式/autoExport 插入改为 noise-aware（`maskNonCode` 等长掩码——字符串/模板/注释中 return/; 不再切坏插入点与尾表达式）
- [x] MEDIUM：非 ASP 模式工具 schema 与执行面同源（剔除 ASP-only 声明）
- [x] MEDIUM：ASP 内联工具（asp_index/memory_index/cache_*）统一进 try/catch 错误回填
- [x] MEDIUM：surface 解构默认值/模板插值/as 断言漏检
- [x] MEDIUM：ext.syncIndex 失效 · manage.scheme.publish id 校验
- [x] LOW：别名门控提前 · toolsDescription done 去重 · 命名一致性

**记忆侧**（→ packages/pth-memory/TODO.md）：H3 谓词下推 · H5 统一入口 · H6 store 纵深 · H7 来源校验 · memoryScope own 读侧 · readSource/toolstore symlink（与沙箱协同）

**沙箱侧**（→ packages/pth-sandbox/TODO.md）：web.fetchText DNS rebinding/流式限量 · N5 资源环 L3 · 编译核/gdb 容量复核 · sandbox exec-api 健康观测
