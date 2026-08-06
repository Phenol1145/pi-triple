# PTL 认知注入 + agent-lab 调度模式打磨 —— 变更总结

> 日期：2026-08-06 · 计划：`docs/superpowers/plans/2026-08-06-ptl-agent-lab-polish.md` · Spec：`docs/superpowers/specs/2026-08-06-ptl-agent-lab-polish-design.md`
> 执行：subagent-driven-development（SDD，7 任务 + 1 轮最终修复波）· 12 commits · 测试全绿（根 vitest 959/959 + agent-lab 1703/1705，2 个为既有失败）

## 背景（要解决的两个 bug）

| # | 用户反馈 | 根因 | 修复方向 |
|---|---|---|---|
| 1 | PTL 会话内 agent 认知不全，要求改 PTL 自身时按裸 pi 模式行事（写错目录、删 symlink、改错文件） | launcher 有模板 PROMPT.md 注入机制但三模板都没内容；agent 拿到的是裸 pi 系统提示，没有 PTL 身份/治理认知 | 走 **pi 原生 AGENTS.md 机制**注入 PTL 身份 + 治理规则 |
| 2 | agent-lab 常常阻塞任务进行；设计澄清：**竞价只是调度模式之一**，调用时应能显式指定模式 | 所有任务默认走竞价（bidding 等回复）；winner 执行无墙钟超时 | 三调度模式（direct/weighted/market）+ 显式指定 + 自动路由 + 执行超时 |

## A 部分：PTL 认知注入（3 任务）

### 交付物
| commit | 内容 |
|---|---|
| `2e91a4a` | `docs/ptl/templates/AGENTS.md.tpl` 模板源 + `src/ptl/template-agents.ts`（`renderTemplateAgents`/`ensureTemplateAgents`/`AGENTS_TPL_PATH`，幂等写入） |
| `87d3076` | 接入 `pit template new`（新模板即生成）+ launcher 启动补写（既有模板幂等回填） |
| `a945d39` | `pit doctor` 新增 AGENTS.md 检查项（缺失/占位符残留即告警） |

### 机制
- 复用 pi 原生上下文加载：`PI_CODING_AGENT_DIR` 已指向模板目录 → pi 启动时自动加载 `data/pi-config/<tid>/AGENTS.md`
- 模板内容 = 身份声明 + 必读引用（`docs/ptl/authoring.md` 决策树 / pi `docs/skills.md` / `docs/extensions.md` / superpowers `writing-skills`）+ 三条铁律速查（写扩展/技能进共享层或模板本地、删 symlink ≠ 卸载、不与 bundled 同名）
- 发布形态修正：`package.json` files 加 `docs/ptl/templates`（否则 npm 安装后 tpl 路径 ENOENT）

### 评审修复
- **ENOENT**：`execTemplateNew` 在无共享层（fresh install）时 templateDir 从未被创建 → AGENTS.md 写入崩溃 → 显式 `mkdirSync`
- `fixable` 语义：AGENTS.md 检查项恒 `false`（修复由 template new/launcher 自动完成，doctor 无交互修复入口）

## B 部分：agent-lab 调度模式（4 任务）

### 交付物
| commit | 内容 |
|---|---|
| `187bf12` | `SchedulingStrategy = "direct" \| "weighted" \| "market"` + `resolveStrategy` 五级路由（显式 > labels.strategy > timed-trigger→weighted > 白名单 > 默认 market）+ `DispatchRequest.strategy?` |
| `a224bc4` | runner 集成：dispatch 开头解析 strategy，`scheduling.requested` 事件携带，SchedulingInput 透传；`strategyConfig` 构造参数（缺省 market/[]） |
| `b684f94` | direct 短路：`--agent <id>` 直通执行绕过竞价；缺 agentId → failed；事件序列与正常 completed 路径对称（抽 `processCompleted` 复用） |
| `08af235` | **winner 墙钟超时**：`withTimeout`（默认 300s，`execution.timeoutMs` 可配贯通 MarketConfig/arena 参数/TUNABLE_PATHS）+ 超时后尽力 abort signal；create-scheduler-runtime 接入 LabConfig 配置 |
| `cd62dc1` | `/lab scheduler dispatch <role> <task...> --strategy <s> [--agent <id>]` 命令层：`parseDispatchArgs` 纯函数（task 空格拼接、`--` 前截断、direct 强制 --agent）+ `renderSchedulerDispatch` + bridge 签名 |
| `e15652c` | **最终修复波**：direct + mode=execute **真正执行** workloop（此前只返回 selectedAgentId 不跑任务）——`getAgent` 全局解析 + agents.run + 超时 + output 透传；select 保持仅指派；bridge roundId 类型同步 |

### 使用方式
```bash
# 在 PTL/PTH 会话内：
/lab scheduler dispatch 编程 修复登录bug --strategy direct --agent agent-x   # 指派：指定 agent 直跑
/lab scheduler dispatch 编程 修复登录bug --strategy weighted                 # 按历史评分选最优
/lab scheduler dispatch 编程 修复登录bug --strategy market                   # 竞价（默认行为）
```

### 阻塞修复效果
- **direct/weighted** 任务不再触发 bidding → 简单任务即时执行（direct 直通、weighted 评分直选）
- **market** 保持竞价，但 winner 执行有 5 分钟墙钟超时兜底（此前无限挂起）
- 定时器派发（timed-trigger）默认走 weighted，不再默认竞价

## 关键设计决策（评审过程沉淀）

| 决策 | 理由 |
|---|---|
| AGENTS.md 走 pi 原生机制而非 PTL 私有 PROMPT.md | pi 一等公民、SDK 升级护栏覆盖、模板隔离天然成立；PROMPT.md 机制保留不启用避免双系统 |
| strategy 显式 > 自动路由 | 调用方可完全控制，缺省时按任务属性自动选模式 |
| direct 不调 impl.schedule | 绕过 bidding 是 direct 的存在意义；执行复用到 sdk.agents.run 统一路径 |
| roundId 放宽可选 | direct 无优化轮次；伪造 "<direct>" 值污染 roundKeyed 数据更差（已评审核查无消费方） |
| execution 校验可选+缺省 300s | 兼容旧 DB 实例参数（不拒绝无 execution 字段的更新提案） |

## 遗留项（均已记账，非 load-bearing）

- agent-lab `weighted-scorer-bootstrap.test.ts` 2 个既有失败（base commit 同样失败，与并行 WIP 相关，非本计划回归）
- 超时后底层 workloop 继续后台运行（best-effort abort，硬终止需另开任务）
- 根 tsc 不覆盖 agent-lab（类型仅运行时测试兜底；本次改动含 0 新增依赖）
- 报告性 minor：计数口误、import 可合并、CLI 参数边界（`--agent` 后跟 flag、task 含 `--` 前缀词截断）等

## 验证证据

- 根仓库：`npx vitest run` → **959/959 全绿**；`npm run lint`（tsc --noEmit）干净
- agent-lab：`npm test` → **1703/1705**（2 个既有失败如上）
- 每任务经 SDD 双评审（spec 符合性 + 代码质量），3 个任务经历修复轮（ENOENT、fixable、direct-execute）
- 三模板（local/knowledge/dev）AGENTS.md 手动验证：写入成功、幂等、无占位符残留、doctor 检查 ok=true
