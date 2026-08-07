# PTL 认知注入 + agent-lab 调度模式打磨设计

> 日期：2026-08-06 · 状态：草案待审
> 来源：用户反馈两个 bug——① PTL 会话内 agent 认知不全、按裸 pi 模式修改自身；② agent-lab 常常阻塞任务进行（竞价是唯一调度路径）。

## 背景

### 问题 1：PTL 会话内 agent 认知不全

**症状**：要求 PTL 修改自身（加扩展/技能/工具、调模板配置）时，agent 常常按照裸 pi 的模式行事——写错目录（`~/.agents/skills/`）、删 symlink 以为能卸载、改错文件。

**根因（已定位）**：
- `launcher.ts` 有模板级系统提示注入机制（`dataDir/templates/<tid>/PROMPT.md` → `--append-system-prompt`），**但三个模板都没有 PROMPT.md**——注入机制存在，内容为零。
- 同时 pi 原生有更标准的认知注入路径：`PI_CODING_AGENT_DIR = data/pi-config/<tid>` 已指向模板目录，pi 从该 agentDir 自动加载 `AGENTS.md` 作为全局上下文，并从 cwd 向上走加载项目级 `AGENTS.md`（`loadProjectContextFiles`，resource-loader.js）。

**已有资产（不应重复发明）**：
- `writing-skills` 技能（superpowers 包，经 settings.json `packages` 加载）——教 agent TDD 式创建技能
- pi `docs/skills.md`（技能位置/SKILL.md 格式/frontmatter 校验）
- pi `docs/extensions.md`（扩展编写规范）
- `docs/ptl/authoring.md`（PTL 特有创作指南：放置决策树、共享层补链陷阱、bundled 覆盖）

### 问题 2：agent-lab 调度阻塞

**症状**：agent-lab 常常阻塞任务进行。用户澄清设计意图：**竞价（市场分配）只是调度模式之一，不计划所有 agent 工作都通过市场分配**；希望完整模式集 + **调用时显式指定调用模式**。

**现状（已勘察）**：
- `SchedulingMode = "select" | "execute"`（这是调度器的内部模式，非调度策略）
- `SchedulerRegistry` 已支持多实现注册：`MARKET_SCHEDULER_DEFINITION_ID`（竞价）+ `WEIGHTED_SCORER_DEFINITION_ID`（加权评分）
- `RoutingBinding`（role/taskCategory/labels → schedulerInstanceId）静态路由已存在，`resolveRoute` 纯函数按 priority 排序
- 调用入口：`/lab scheduler select <role>`（mode: select）、定时器 `timed-trigger.ts` dispatch、subscription dispatcher
- **阻塞点**：
  1. 竞价流程本身（bidding 等回复，`bidding.timeoutMs: 10000`，`maxCallsPerDispatch: 6`，并发 3）——简单任务也被拖进市场
  2. winner 执行 `await sdk.agents.run(...)` **无 `Promise.race` 超时封装**（workloop 默认 maxTurns 100，卡住即无限阻塞）
  3. stale 任务 `staleTaskTimeoutMs: 600000`（10 分钟）才清理

## 设计

### 部分 A：PTL 认知注入（AGENTS.md）

**决策**：走 pi 原生 `AGENTS.md` 机制，不依赖 PTL 私有 PROMPT.md 注入。

**A1. 模板 AGENTS.md**

每个模板目录写 `data/pi-config/<tid>/AGENTS.md`，内容轻量（身份 + 引用，不做知识重复）：

```markdown
# 你是 PTL（Pi-Triple-Lite）模板环境中的 pi agent

- 当前模板：<templateId>（别名 <alias>），配置根：<PI_CODING_AGENT_DIR>
- 修改本环境（扩展/技能/工具/配置）时，必须遵守 PTL 治理规则，先读：
  1. <repo>/docs/ptl/authoring.md —— PTL 放置决策树 + 陷阱清单（唯一真相源）
  2. pi 官方 docs/skills.md、docs/extensions.md（npm 包内）
  3. 创建技能前加载 writing-skills 技能（superpowers 包）
- 铁律（速查）：
  - 写扩展/技能 → PTL 共享层（~/.pi-triple/data/shared/）或模板本地，绝不写 ~/.agents/skills/（体制外）
  - 删模板内共享层 symlink ≠ 卸载（下次启动复活）
  - 不要与 bundled 扩展同名（ptl update --all 会覆盖）
```

**内容来源管理**：AGENTS.md 正文维护在仓库（`docs/ptl/templates/AGENTS.md.tpl`），安装/升级模板时由 PTL 渲染 `<templateId>/<alias>` 占位符写入模板目录。这样内容可版本化、可随仓库演进。

**A2. 模板 PROMPT.md 去留**：机制保留（launcher 已实现），本次不启用——AGENTS.md 已覆盖需求，避免双系统维护。后续若有模板级"系统提示替换"需求（SYSTEM.md 语义）再启用。

**A3. 验证**：`ptl doctor` / 新会话首轮自我认知确认；写一条检查项确认 AGENTS.md 存在且被 pi 加载。

### 部分 B：agent-lab 调度模式

**B1. 调度策略枚举**（新增，区别于内部 SchedulingMode）：

```ts
type SchedulingStrategy = "direct" | "weighted" | "market";
// direct:   显式指定 agent 执行（指派）——绕过竞价，无 bidding 阻塞
// weighted: 按历史加权评分选最优（现有 WEIGHTED_SCORER）
// market:   竞价（现有 MARKET_SCHEDULER）
// （round-robin 本轮不做——YAGNI，后续需要再补）
```

**B2. DispatchRequest 显式指定**

```ts
interface DispatchRequest {
  // ...现有字段
  strategy?: SchedulingStrategy;      // 显式指定；缺省走自动路由
  strategyHint?: string;              // 供 resolver 参考的自由文本
}
```

- `/lab scheduler dispatch <role> <task> --strategy direct|weighted|market [--agent <agentId>]`（新增子命令或扩展现有入口；`--strategy direct` 时必须提供 `--agent`，缺省报用法错误）
- `timed-trigger.ts` / subscription 派发的任务，若无显式 strategy 走自动路由

**B3. 自动路由 resolver**（新增纯函数，可测）

```
strategyResolver({ role, taskCategory, labels, caller }) → SchedulingStrategy
规则（v1 简单可解释）：
1. labels.strategy 显式 → 直接采用
2. caller === "timed-trigger" → "weighted"（定时任务默认不竞价）
3. role 命中 weighted 白名单配置 → "weighted"
4. 否则默认 → "market"
```

配置项：`scheduler.defaultStrategy`（默认 "market"，可改为 "weighted"）、`weightedRoles: string[]`。均走现有 config 机制（`mergeConfig` 风格）。

**B4. winner 执行超时封装**（阻塞修复，独立于策略）

`runner.ts` dispatch 到 workloop 时用 `Promise.race` 包一层超时：

```
W = { timeoutMs: <scheduler 配置，默认 5min>, signal 取消 workloop }
超时 → dispatch 返回 failed(代码 timeout)，事件账本记 dispatch.failed(reason=timeout)
```

配置：`execution.timeoutMs`（arena-definition 参数模型扩展）。注意与 workloop 内部 `maxTurns: 100` 语义互补（前者墙钟、后者步数）。

**B5. 阻塞行为预期**：
- direct/weighted 策略的任务不再触发 bidding → 简单任务即时执行
- market 策略的 bidding 等待保持现状（真实竞价需要），但 winner 执行有墙钟超时兜底
- stale 清理周期可配置（顺手暴露 `staleTaskTimeoutMs` 到参数模型，非必做）

**B6. 测试**：
- resolver 单元测试（显式/白名单/默认三分支 + 定时器 caller）
- dispatch 集成测试：direct 直达 winner 不经过 bidding；weighted 走 scorer；market 走竞价
- 超时测试：mock 挂起 workloop，验证 timeoutMs 后返回 failed + 账本事件

### 部分 C：范围与依赖

- 部分 A 改动 `src/ptl/`（模板渲染）+ 新增 AGENTS.md 模板内容；不触碰 pi 本体
- 部分 B 全部在 `extensions/agent-lab/` 内；PTH 常驻会话与 PTL 模板共享该扩展，两侧同时生效
- 无数据迁移需求；`/lab market` 等现有命令保持兼容（默认策略 market 时行为不变）
- 本次不处理：degraded 检测语义裁决、observe 模型前置（联邦后续任务）

## 交付物

1. `docs/ptl/templates/AGENTS.md.tpl` + 渲染逻辑（`src/ptl/`）
2. 三个模板 AGENTS.md 生成 + 验证加载
3. `SchedulingStrategy` 类型 + resolver + config 扩展
4. `/lab scheduler dispatch --strategy` 命令
5. winner 执行超时封装
6. 测试（resolver / dispatch 集成 / 超时）+ 全量回归 950+ 绿
