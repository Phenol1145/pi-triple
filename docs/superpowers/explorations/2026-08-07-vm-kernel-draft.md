# vm 内核设计草案（进行中，未定稿）

- 日期：2026-08-07
- 状态：**草案**（brainstorming 进行中，多项待裁决——设计尚未收敛，勿作为 spec 依据）
- 触发：Prime Agent 启发 + 交叉 brainstorm panel（deepseek-v4-flash / deepseek-v4-pro / qwen3.8-max）+ 结构审计

---

## 1. 设计动机

Prime Agent（Prime Intellect 2026-08-05）的核心范式：**"只有一个工具"**——persistent IPython kernel 统一承载 skills/MCP/context/rlm()，工具调用变成程序设计（Programmatic Tool Calling, PTC）。我们将其映射到 pi-platform：vm context 作为统一执行内核。

## 2. 已收敛的形态（用户指示，已确认）

```
vm 内核 = 唯一的执行面（统一解释执行）
  ├─ pi 的 extension → 改写为 TS 可复用编程片段（代码库，不再经 ExtensionAPI 加载）
  ├─ pi 的 skill（SKILL.md）→ 可执行的 TS 模块（代码库）
  ├─ 记忆系统（L3 语义记忆 + WM 工作记忆）→ 能力注入（代码库）
  ├─ task 动词（peek/claim/reject/submit/execute）→ 能力注入（代码库）
  └─ 统一存储后端 → 一个存储（形态待裁决）
       ↓
  vm context 统一解释执行（persistent kernel，TypeScript）
```

**关键范式转变**：extension 机制从"独立加载的扩展"退场为"代码库里的可复用 TS 片段"，由 vm 内核统一解释执行。这与结构审计发现的"CLI 化迁移路线（扩展机制退场）"方向一致。

## 3. 技术底座（已确认可行）

- **vm 模块**（node:vm）：`vm.createContext()` 创建持久上下文（= IPython kernel 等价物），`vm.runInContext(code, context)` 反复执行，状态保留在 context 对象（= kernel state）
- **TypeScript 执行**：`stripTypeScriptTypes()`（Node 22.6+，pi 已在用 `--experimental-strip-types`）TS→JS 后喂给 vm——零新依赖
- **能力注入模型**：context 默认空，只注入白名单能力（联邦动词/记忆/WM），不注入 fs/child_process/net——比"沙箱化任意代码"更可靠（语言层面无能力，而非运行时对抗）
- **持久性分层**：vm context（进程内热态）↔ WM（sqlite，会话级持久）↔ 转录（JSONL，任务级档案）

## 3.5 会话层决策（2026-08-07 裁决：方案 C）

**保留 pi SDK / pi 自带件**（provider 兼容等用 pi 自带的）：
- `ModelRuntime`（provider 兼容：密钥/failover/协议）——sdk-adapter 已透传
- `SessionManager`（JSONL 落盘/恢复）——SDK 可独立使用
- `createEventBus`（事件总线）——已独立再导出
- `model-router`（shared/，独立于 SDK）

**自研件**（vm 内核 = 完整 agent 运行时）：
- AgentSession 回合循环主体（LLM 调用 + 上下文管理 + 工具协议解析 + 回填 + 流式/中止）
- 唯一工具 vm_kernel（PTC 风格：agent 视角只有一个工具）
- 能力注入（记忆/task/skill 展开）
- 统一存储后端

**工程量估算（实测对比）**：方案 A（保留 SDK 回合）~1100 行/风险低/愿景 50%；方案 B（全自研）~2400-3000 行/风险中高/愿景 100%；方案 C（折中）~1800-2200 行——保留 SessionManager/eventbus/provider，自研回合循环 + vm 内核。

**pi SDK 实际使用面**：172MB/4.5 万行 JS dist，PTH 仅用 4 个 API（createAgentSession/bindExtensions/createEventBus/DefaultResourceLoader）；agent-lab 对 SDK 依赖仅 pi.events + ExtensionAPI 类型。

## 3.6 统一存储后端决策（2026-08-07 裁决：postgres 为目标后端）

**决策**：vm 内核统一存储的目标后端 = **postgres**（docker 服务），非 SQLite 非 FS。

**出处**：`extensions/agent-lab/docs/framework-vs-construction.md:81` 悬置问题（共享卷/账本服务化/postgres 化，Q3 未裁决）——现裁决：postgres 化。

**理由**：多容器/多进程共享（FS 记忆域与 SQLite 单进程独占）、统一存储后端（记忆/转录/任务/账本一库装下）、MVCC 并发。

**附带后果（待重新设计）**：
- 容器化架构重想（compose 加 postgres 服务；当前 4 服务：pi-platform/sandbox/redis/dev）
- PTH 架构重想（现 Redis+SQLite+FS 三介质分散；记忆系统 FS 模式、agent-lab.db SQLite、会话痕迹 Redis）
- 用户提示"感觉有点走偏"——vm 内核设计可能建立在旧 PTH 架构假设上，需重新审视

## 4. 已裁决的设计点

| # | 决策 | 内容 |
|---|---|---|
| 1 | 生命周期载体 | WM 挂会话（非任务）——保分析者综合阶段；张力显式化："WM 是机械托底的状态载体，不是思考本身" |
| 2 | C 执行语义 | 逐条判别式失败不中断（非原子批——原子性在跨时间尺度操作上是幻觉，且违反六状态机） |
| 3 | peek 前置 | peek（只读不锁定）先于 claim/reject——"认领即承诺"；修正了"claim 后自检"的旧模型 |
| 4 | 经济闸门 | 缓行（货币系统未落地前只做动词族不做计费） |
| 5 | 定位 | **给 PTH 用**（非 PTL）；在 pi-platform 内运行（不本地直接跑） |

## 5. 未裁决的开放问题（brainstorming 待继续）

1. **挂载点**：审计结论 = PTH 会话层（agent-engine.ts:613-621 sdkCreateSession / sdk-adapter），vm 内核 = PTH 会话执行基座，代码落 src/pth（或 src/shared）——但用户最新指示（统一 extension 为代码库）可能改变挂载形态，待确认
2. **"一个 tool"的形态**：修正后 = 不是 PTH customTool，而是"唯一执行面"（extension 退场为代码库，vm 统一解释执行）——精确形态待定稿
3. **统一存储后端**：形态未定（SQLite 统一 vs 文件 vs 双后端统一访问层）——用户提出"统一之前开发的记忆系统 + pi 自身 skill/extension + 统一存储后端"，存储统一是核心
4. **PTH 与 agent-lab 关系**：agent-lab 本身是被 PTH 托管的 extension——vm 内核统一 extension 后，agent-lab 的模块（taskpool/memory/scheduler）也变代码库？agent-lab.db 并入统一存储？——待用户裁决
5. **vm 内核与 pi SDK AgentSession 的关系**：✅ 已裁决（方案 C）——保留 SessionManager/eventbus/provider（ModelRuntime），自研回合循环主体 + vm 内核
6. **容器化/PTH 架构**：✅ 方向裁决（2026-08-07）——postgres 为目标后端，需重新设计容器化架构与 PTH 架构（用户指示"重新考虑，感觉走偏了"）——具体设计待新架构讨论

## 6. 相关参考

- 结构审计：`docs/superpowers/explorations/2026-08-07-structure-recon/structure-audit.md`（6 scout 综合）
- 侦察报告：`docs/superpowers/explorations/2026-08-07-structure-recon/scout-1..6-*.md`
- Prime Agent 会话：`/tmp/chatgpt-6a75a876.md`
- 交叉 brainstorm panel：`docs/superpowers/explorations/2026-08-07-prime-agent-panel/`（proposal-*.md / cross-*.md / alignment.md / adjudication.md）
