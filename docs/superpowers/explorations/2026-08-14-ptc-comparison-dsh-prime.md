# PTC 模式三方对比：DSH × Prime Agent × PTH（参考文档）

> 日期：2026-08-14 · 类型：exploration（外部参考）· 来源：DSH npx 编译产物（dsh-code-runtime / dsh presets）+ 本仓 2026-08-08 PrimeAgent 参考文档 + PTH 代码事实
> 关联：[Prime Agent 调研与 PTH 对照](./2026-08-08-prime-agent-reference.md)、[Kernel 设计综合总览](../specs/2026-08-09-pth-kernel-design-synthesis.md)

> **性质说明**：外部参考 exploration，不是 PTH 的规范性设计。"可借鉴"条目为候选方向，落地须走概念先行（concepts.md 词表/原则更新）+ 用户裁决。

## 1. 背景

PTH 的 PTC（程序模式）已落地（agent-loop 提示词【程序模式】+ ts vm 能力注入）。用户要求横向参考两个同样有 PTC 模式的项目——DeepSeek Harness（Code Mode SDK）与 Prime Agent（persistent IPython）——对照实现差异，提炼可借鉴点。本文即该对照的落档；2026-08-08 的 PrimeAgent 参考文档写于 PTH 实现 PTC 之前，其"PTC 差距"结论已过时，以本文为准。

## 2. 三方 PTC 机制

### 2.1 DSH：Code Mode SDK（TypeScript 程序 × 类型化绑定）

- **定位**：PTC 模式 = 标准模式**全部能力**换个呈现方式（preset.yml：*"具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作"*）——不是裁剪工具面，是换呈现形态。
- **核心包 dsh-code-runtime**，自述为 *"runs one model-written program against host async bindings"*：
  - 工具 = 类型化异步绑定（`tools.bash({command, description})` 式声明表直接进 prompt——**类型声明本身就是 API 文档**）；
  - **Seam 分层**：*"Runtimes know nothing about tools or sessions; consumers own those concerns"*——运行时只管"程序 × 绑定"的执行缝，工具注入与会话全部由上层 harness 拥有；
  - **多后端可移植契约**：JS worker + Python 后端双实现，共享 `RESERVED_BINDING_GLOBALS`（console/`__dsh_main__`/`__builtins__`/`__name__`/`__debug__`）、错误类成员保留表、dunder 拒绝规则、可移植保留字——**同一份程序跨后端语义一致**；
  - **敌意程序假设**：*"structured-cloneable bindings … treat programs as hostile peers, isolate runs from one another, and terminate and await in-flight runs during disposal"*——运行隔离 + 可终止 in-flight；
  - 工具生态插件化：dsh-tool-bash / fs / fs-search / str-replace-editor / web / skill / subagent / workflow / goal / todo / ralph … 全部可经同一绑定面进入程序。

### 2.2 Prime Agent：persistent IPython（唯一真正的工具）

- **Tool Calling → Program Synthesis**：filesystem/shell/skills/MCP/context/rlm 全部以 Python module/function 暴露进持久 IPython——模型写 Python 编排一切（for/if/并发/变量由 Python 提供）。
- **IPython = 工作记忆**：分层记忆 context（≈cache）/ kernel（≈RAM）/ disk（≈持久）——变量与对象跨调用存活。
- **rlm() 动态递归子代理**：运行时生成持久 child agent tree——与 DSH/PTH 的最大差异点。
- **Continual Harness 自修改**：/refine 轨迹分析 → 最小 harness 修改（可回滚）。
- **风险实录**：无沙箱（裸 OS）；reward hacking 实证（RCON 作弊 → /refine 固化作弊 skill）。

### 2.3 PTH：PTC 程序模式（ts 组织语言 × 核后端）

- agent-loop【程序模式（PTC——优先使用）】：优先 ts.run 写完整程序一次性组合多 kernel/能力；单行用 ts.eval；ts 程序运行在 vm 沙箱、可 await 能力函数（memory/fs/web/llm/bash/python + ext）；results/context 跨步骤传值；单 kernel 简单步骤可直接 python.run/bash.run。
- 交互核三分类（concepts.md 0.10.2）：③纯工具调用 ⊂ ①单语言核（纯 ts PTC）⊂ ②多语言核（ts 组织 + python 计算 + bash 环境管理，各带职责定位）。
- 安全最强：sandbox 容器零出口网络 + capability 白名单 + EXEC_TOOL_CAP + 审批面 A/B/C + 负结果收敛/deopt。

## 3. 三方对照表

| 维度 | DSH PTC | Prime Agent PTC | PTH PTC（现状） |
|------|---------|-----------------|-----------------|
| 编排语言 | TypeScript | Python（IPython） | TS 组织 + python/bash 作能力后端 |
| 工具暴露 | 类型化 async 绑定（声明进 prompt） | Python module/function | vm 内 await 能力函数（散文式文档） |
| 跨调用状态 | 无（靠返回值/文件） | IPython 持久 kernel | results/context 对象 + REPL 持久核（stateless/repl 双模式） |
| 后端 | JS+Python 双后端、可移植契约 | IPython 单后端 | JS vm + exec-channel 远程 python/bash 核（语言路由） |
| 分层 | 运行时/工具/会话三层解耦（Seam） | 全耦合进 IPython | 工具注入与 vm 耦合（ts-interpreter 内 buildCapabilities） |
| 程序终止语义 | dispose 终止并 await in-flight | 无（裸进程） | LLM 超时 + claim 回收（ts 程序 in-flight 终止无显式语义） |
| 递归子代理 | subagent/workflow 工具（会话级） | rlm() 持久 child tree | 静态谱系 + 分化（无运行时递归） |
| 安全 | 敌意程序隔离 | 无沙箱（官方警告） | 沙箱+白名单+审批面（最强） |

## 4. 对 PTH 的可借鉴清单（候选——非规范性）

1. **工具契约类型化**（DSH）：能力函数面从散文文档改为"签名 + 场景锚点 + 效果预告"结构化契约——与 T8 三要素裁决天然同构，可作为 T8 文案改写的目标形态。
2. **Seam 解耦**（DSH）：ts vm 只管"程序 × 绑定"，工具装配上移——现状 buildCapabilities 在 ts-interpreter 内构造，新增扩展要动核；解耦后核稳定、工具面可插件化装配（与 PTH 的 toolstore/ext 方向一致）。
3. **in-flight 终止语义**（DSH）：补"dispose 终止运行中程序并 await"的显式契约——现在只有调用级 LLM 超时与任务级 claim 回收，程序级跑飞无制动（负结果收敛是语义层，非执行层）。
4. **动态递归子代理**（Prime rlm）：运行时 spawn 持久 child agent——与 2026-08-08 参考文档 Phase 3 候选一致；PTH 静态谱系 + 分化的最大架构差距。
5. **harness 自修改治理**（Prime 警示）：PTH 已有审批面/deopt/负结果收敛防线，若引入轨迹级 /refine 需保留"trigger+结果+回滚"语义（对齐原文档 Phase 2/3 候选）。
6. **多后端可移植契约**（DSH）：PTH exec-channel 已有语言路由，但无"同一程序跨后端语义一致"承诺——如未来支持模型直接写 python 程序（Prime 式），需先定可移植标识符契约。

## 5. 结论

三方同源（Tool Calling → Program Synthesis），差异在编排语言、状态载体与安全边界。PTH 的 PTC 处于中间态：有 Prime 的持久核与分层记忆、有 DSH 的异步绑定雏形（但缺类型契约与 Seam 解耦）、安全最强但缺运行时递归。**短期最值得拿的是 ①（与 T8 合并）与 ②（Seam 解耦）；③ 是执行层加固；④ 是远期架构方向。**
