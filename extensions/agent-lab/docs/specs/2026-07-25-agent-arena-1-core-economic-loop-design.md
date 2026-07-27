# Agent Arena-1 — 核心经济闭环 设计稿

- **日期**：2026-07-25
- **状态**：设计已确认（待实现规划）
- **子项目范围**：Agent Lab 平台的第二个子项目 = **Agent Arena 核心经济闭环**（S1 credit 账本+初始发放 / S2 任务发布+出价接取 / S3 结算 / S7 最小手动编排），建在已交付的 Core+M1+M2 之上。
- **扩展**：`agent-lab`（Arena 作为其 `arena/` 模块，**不**独立扩展）
- **明确不在本子项目范围**（后续独立子项目）：记忆空间(Arena-2)、换模型/求知识市场(Arena-3)、破产+知识商店(Arena-4)、赔率遥测反推+探索治理(Arena-5)、次级市场/分包(Arena-6)、聘用工作流(Arena-7)、合作并行+Judge 分润(Arena-8)、Lab Dashboard TUI `/lab launch`(Arena-9)。

---

## 1. 概述与目标

在 Market 模式下，把 subagent 派发变成一个**市场经济**：模型作为"玩家"持有 credits，对任务**押注竞价**，中标者上岗，按结果**结算** credits（奖励/惩罚/用量成本/任务税）。目标（A+B 统一）：

- **A 去中心化模型选择**：用市场信号（押注/赔率/结算）替代或补充 M2 中心打分，选出性价比最优模型。
- **B 涌现生态**：agent 竞争、积累 credit，观察涌现行为。

**架构方针（硬约束）：接口优先、抽象经济机制、留足扩展空间。** 经济规则全部落在可插拔策略接口后，v1 给具体实现；后续机制（记忆/知识/工具/反思、次级市场、合作分润、TUI）不换骨架即可接入。

## 2. 关键决策记录（brainstorming 结论）

| 维度 | 决策 |
|------|------|
| 出价机制 | **B** — stake-based，**逐个问候选模型愿押多少**（轻量 prompt）；接口保留"公式押注"实现以便日后省成本切换 |
| 初始 credits | **A** — 反比于 blended price：`round(K / max(blendedPrice, floor))`；参数量等更合适数据源留待后续（经 `EndowmentPolicy` 接入）|
| 任务对象 | **A** — 最小必要集 `{id, role, prompt, difficulty, odds, reward}`，可扩展 |
| 结算 | **A** — 押注×赔率博彩式；**CostModel** 含 token + 工具(复杂度/时长/资源) + 推理时长 三类成本 |
| 触发 | **mode 切换**（Classic/Market）；Market 模式**自动转化**每次 subagent 派发为市场任务 |
| 架构 | **甲** — 策略对象 + Market 编排器，建在 agent-lab 内，复用 Core |
| 命令 | Arena 操作挂 `/lab` 下（`/lab arena …`）；`/lab mode` 快速切换；所有设置走 `/lab config` |
| 轮次 | **A** — 全局 `round`（每任务 +1）+ per-agent `agent_turn` 都记 |
| 身份 | v1 = **模型**（单一维度）；`AgentId`/`AgentState` 可扩展，待 记忆/知识/工具/反思 引入后身份真正成型 |
| odds | 任务"风险/收益倍数"，由难度定；v1 难度档 1.5/3/5；后续可由遥测反推 |

## 3. 架构

### 3.1 模块布局（新增 `src/arena/`）

```
src/arena/
├── types.ts        # ArenaTask/Bid/Outcome/Mode + 策略接口 + AgentId/AgentState
├── ledger.ts       # Ledger（Store 记账：余额/冻结/流水/轮次）
├── policies.ts     # 策略接口 + v1 实现（Endowment/Odds/Bidding/Settlement/CostModel/Judge占位）
├── market.ts       # Market 编排器（allocate 征bid选中标 / settle 结算）
└── register.ts     # pi 胶水：/lab arena 命令 + agent_lab 工具扩展 + mode 感知钩子
```

复用 Core 的 `store` / `catalog` / `telemetry` / `scorer`。

### 3.2 身份建模（v1）与演进

- **v1：`AgentId = 模型 id`**（如 `deepseek/deepseek-v3.2`），credits 记在模型上（初始额由价格反比得出）。任务 `role` 用于遥测分组与（可选）投标资格过滤。
- **演进**：`AgentId` 为不透明抽象、`AgentState` 可扩展；后续引入 记忆空间/知识空间/工具空间/反思 后，身份成型为 `模型 + 记忆 + 知识 + 工具 + 反思` 复合体。Ledger 与策略只依赖接口，维度增长不动骨架。

```ts
export type AgentId = string;   // v1 = model id
export interface AgentState {
  agent: AgentId;
  model: ModelInfo;
  balance: number;
  // 预留扩展（后续子项目填充，非 v1）：
  // memory?: MemoryHandle; knowledge?: KnowledgeHandle;
  // tools?: ToolSpaceHandle; reflection?: ReflectionHandle;
}
```

### 3.3 策略接口（接口优先核心）

```ts
export type Mode = "classic" | "market";

export interface ArenaTask {
  id: string;            // = toolCallId（关联键）
  role: string;
  prompt: string;
  difficulty: "easy" | "medium" | "hard" | number;
  odds: number;
  reward: number;
}

export interface Bid { agent: AgentId; stake: number; }

export interface Outcome {
  completion: number;        // 0..1，来自 acceptance 遥测
  majorError: boolean;
  tokensIn: number;
  tokensOut: number;
  cost: number;              // 真实美元成本
  toolCalls: { name: string; durationMs: number }[];
  inferenceLatencyMs: number;
}

export interface EndowmentPolicy { initialCredits(m: ModelInfo): number; }
export interface OddsPolicy { odds(t: ArenaTask): number; }
export interface BiddingPolicy { solicitBids(t: ArenaTask, c: AgentState[]): Promise<Bid[]>; }
export interface SettlementPolicy { settle(t: ArenaTask, stake: number, o: Outcome): number; } // 净增减 D（不含用量成本）
export interface CostModel { usageCost(o: Outcome, m: ModelInfo): number; }                     // 用量成本 U（credits）
export interface Judge { score(t: ArenaTask, outputs: unknown[]): number[]; }                   // 占位，Arena-8 用
```

### 3.4 Ledger 与 Market

```ts
export interface Ledger {
  balance(a: AgentId): number;
  ensureEndowed(a: AgentId, m: ModelInfo): void;          // 首次出现时按 EndowmentPolicy 发放初始 credits
  credit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  debit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  freeze(a: AgentId, amt: number, taskId: string): void;
  unfreeze(a: AgentId, taskId: string): number;           // 返回解冻额
  leaderboard(): { agent: AgentId; balance: number }[];
  history(a?: AgentId, limit?: number): CreditTx[];
  currentRound(): number;
  nextRound(): number;                                     // current_round + 1 并持久化
  agentTurn(a: AgentId): number;                           // 该 agent 已参与任务数
}

export interface Market {
  allocate(t: ArenaTask): Promise<{ winner: AgentId; model: string; stake: number; taskId: string; round: number } | undefined>;
  settle(taskId: string, o: Outcome): void;
}
```

### 3.5 数据模型（store 新增表）

```sql
CREATE TABLE credits (
  agent TEXT PRIMARY KEY,
  balance REAL NOT NULL,
  frozen REAL NOT NULL DEFAULT 0,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE credit_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT,
  task_id TEXT,
  round INTEGER,          -- 全局市场轮次
  agent_turn INTEGER      -- 该 agent 的第几次任务
);
CREATE TABLE market_tasks (
  task_id TEXT PRIMARY KEY,
  round INTEGER,
  role TEXT, prompt TEXT, difficulty TEXT,
  odds REAL, reward REAL,
  winner TEXT, stake REAL,
  status TEXT,            -- pending | settled | failed
  created_ts INTEGER
);
CREATE TABLE market_meta ( key TEXT PRIMARY KEY, value TEXT );   -- current_round 等
```

> 轮次：`market_tasks.round` 与对应 `credit_tx.round` 打全局轮次号；`credit_tx.agent_turn` 记 per-agent 轮次。余额快照表（`credit_snapshot`）留到 TUI 子项目（可由 `credit_tx` 派生）。

### 3.6 模式与命令命名空间

- `LabConfig` 增 `mode: "classic"|"market"`（默认 `classic`），作为**普通 config 键**，经 `/lab config mode <…>` 或便捷别名 `/lab mode <…>` 设置。
- 设置统一走 `/lab config <key> [value]`（mode、weights.*、endowment.*、odds.*、settlement.*、cost.*、bidding.*、market.* 等皆为 config 键，新增旋钮不新增关键字）。
- Arena 操作挂 `/lab arena …`；Core 命令不变。

## 4. 数据流

**关联键**：`tool_call` 与 `tool_execution_end` 共享 `event.toolCallId`，用作 `taskId`（`market_tasks.task_id = toolCallId`）配对 allocate 与 settle。

### 4.1 Market 模式 — 自动转化闭环（核心）

```
subagent 派发 (input.agent=role, input.task=prompt)
 └ interceptor tool_call (toolName=subagent), cfg.mode==="market":
    1. 构造 ArenaTask{id=toolCallId, role, prompt, difficulty, odds=OddsPolicy, reward}
    2. round = Ledger.nextRound()
    3. candidates = 目录候选模型（ensureEndowed 初始 credits）→ AgentState[]（含余额）
    4. bids = BiddingPolicy.solicitBids(task, candidates)
         └ v1: 逐个候选模型发轻量 prompt（任务/赔率/你的余额 → 押多少?），解析 stake（截断到可用余额）
    5. winner = stake 最大者（平局：可用余额高者；仍平按 `agent` id 字典序——保证确定性、可测试）
    6. Ledger.freeze(winner, stake, taskId)；market_tasks 写 pending(round, winner, stake, odds)
    7. event.input.model = winner 模型；放行
 └ subagent 以 winner 模型运行
 └ telemetry tool_execution_end (toolName=subagent):
    1. 照常记 M1 遥测
    2. 若存在 market_task(taskId)（不论当前 mode）：
       outcome = { completion(acceptance), majorError, tokens, cost, toolCalls(时长), inferenceLatencyMs }
       D = SettlementPolicy.settle(task, stake, outcome)
       U = CostModel.usageCost(outcome, winnerModel)
       Ledger.unfreeze(winner, taskId)
       Ledger.credit/debit(winner, D − U, reason, taskId, round)   # agent_turn 自增
       market_tasks.status = settled
```

### 4.2 Classic 模式（不变）

interceptor → M2 推荐 + 自动应用；telemetry → M1 记录；**不做市场结算**。

### 4.3 显式 `/lab arena post`（任意模式手动触发一轮市场）

```
/lab arena post <role> "<prompt>" [--difficulty D] [--odds N] [--reward N]
 → 构造 ArenaTask → Market.allocate（征 bid 选 winner）→ 派发 subagent(role, model=winner, task)
 → 完成后 Market.settle → 输出中标模型与 credits 变化
```
（命令内派发 subagent 经 pi 的 subagent 机制；细节留 spec/plan。）

### 4.4 只读命令

`/lab arena credits | leaderboard` → `Ledger.leaderboard()`；`/lab arena history [agent] [--limit N]` → 流水；`/lab arena task <id>` → 任务状态（并触发该任务陈旧恢复）。

## 5. SettlementPolicy v1 公式 与 CostModel

### 5.1 结算（freeze → unfreeze → 净增减）

1. allocate：`freeze(winner, S)`（S 从余额转入冻结）。
2. settle：`unfreeze` 返还 S，再应用净增减 `D` 与用量成本 `U`：`balance += D − U`，钳制 `≥ 0`（v1 不允许负债；破产留待 Arena-4）。
   - **成功**（completion=1，无重大错误）：`D = +S×(O−1)`
   - **部分完成**（c∈(0,1)）：`D = +S×(O−1)×(2c−1)`（c=1 全奖、c=0.5 持平、c<0.5 净亏）
   - **重大错误**：`errorMode=stakeOnly → D=−S`；`errorMode=stakeTimesOdds → D=−S×O`
   - **弃接**（相符却拒绝/未中标）：扣任务税 `tax`

### 5.2 CostModel（用量成本 U，credits）

```
U = tokenCost + toolCost + inferenceCost
tokenCost     = (tokensIn×priceIn + tokensOut×priceOut) × cost.tokenMult
toolCost      = Σ over toolCalls ( toolWeight[name] × durationMs × cost.resourceFactor ) × cost.toolMult
inferenceCost = inferenceLatencyMs × cost.latencyMult
```
- `priceIn/Out` 来自模型 catalog pricing（每百万 → 每 token 换算）。
- `toolWeight` 为可配置 per-tool 复杂度权重（复杂度/资源占用无直接观测，v1 用权重 + 时长代理）。

### 5.3 BiddingPolicy v1（逐个问模型押注）

对每个候选模型发轻量 prompt（模板可配置 `bidding.promptTemplate`），大意：
> 任务：<prompt>（角色 <role>），难度 <difficulty>，赔率 <odds>。你当前 credits：<balance>。可押不超过可用余额。你押多少 credits 接此任务？只回一个数字。

解析返回数字为 stake；截断到可用余额 `balance − frozen`；非法/超时 → stake=0。

## 6. 错误处理（核心：fail-open，绝不阻断派发）

| 场景 | 处理 |
|------|------|
| **`Market.allocate` 任何异常** | **fail-open**：回退 classic 分配（M2 推荐）或放行原模型；记日志，绝不阻断派发 |
| 单个候选 bid 查询失败/超时 | 该候选 `stake=0`（或排除），继续其余 |
| 全部 bid 失败 / 无候选 | 回退 classic 分配 |
| 押注超过可用余额 | stake 截断到 `balance − frozen` |
| 余额扣穿 | 钳制到 `0`（v1 无负债）|
| **结算异常** | 记日志 + **解冻押注**（避免资金卡死），credits 保守处理 |
| **pending 任务未结算**（崩溃/无 tool_execution_end）| 陈旧恢复：检测超时 pending（`market.staleTaskTimeoutMs`）→ 解冻 + 标记 `failed`（启动时或 `/lab arena task` 触发）|
| allocate 与 settle 间切换 mode | settle 依据 **`market_task` 是否存在（按 taskId）**，而非当前 mode |
| 并发派发 | SQLite 串行写；每次 allocate/settle 独立事务 |
| bid 返回值不可信 | 数值解析 + 截断，非法 → 0（防注入/乱报）|

> 退化路径：Market 失败自动降级为 Classic（M2）分配。

## 7. 配置默认值（`/lab config <key> <value>`，全可调）

| 键 | 默认 | 说明 |
|----|------|------|
| `mode` | `classic` | 工作模式 |
| `endowment.K` / `endowment.floor` | `100` / `0.05` | 初始 credits = round(K/max(price,floor)) |
| `odds.easy/medium/hard` | `1.5 / 3.0 / 5.0` | 难度赔率档 |
| `settlement.tax` | `5` | 任务税（credits）|
| `settlement.errorMode` | `stakeTimesOdds` | 重大错误扣罚：`stakeOnly` / `stakeTimesOdds` |
| `cost.tokenMult` / `cost.toolMult` / `cost.latencyMult` | `1.0` | 三类成本倍率 |
| `cost.toolWeights` | `{bash:1.0, edit:0.8, write:0.8, read:0.2, …}` | 工具复杂度权重 |
| `cost.resourceFactor` | `1.0` | 资源占用代理倍率 |
| `bidding.timeoutMs` | `10000` | 单候选征 bid 超时 |
| `bidding.promptTemplate` | （内置轻量模板）| 征 bid 提示词 |
| `market.staleTaskTimeoutMs` | `600000` | 陈旧 pending 超时 |
| `market.eligibility` | `all` | 投标资格：`all` / role→模型glob 映射 |

## 8. 命令与工具

- `/lab mode [classic|market]` — 查看/快速切换模式（= `config mode`）
- `/lab arena post <role> "<prompt>" [--difficulty D] [--odds N] [--reward N]` — 显式发任务跑一轮市场
- `/lab arena credits` / `leaderboard` — 各 agent 余额排行
- `/lab arena history [agent] [--limit N]` — credits 流水（含 round / agent_turn）
- `/lab arena task <id>` — 任务状态（并触发陈旧恢复）
- `/lab arena doctor` — 市场健康（mode / 已发放 agent 数 / pending / 陈旧任务 / current_round）
- `agent_lab` 工具增 `arena-credits` / `arena-post` 动作
- Core 命令不变（recommend/stats/models/log/pin/unpin/config/doctor）

## 9. 测试策略

| 层 | 测试 | 方式 |
|----|------|------|
| **Ledger** | credit/debit/freeze/unfreeze/balance/ensureEndowed/leaderboard/history；冻结-解冻守恒；debit 钳制 0；流水含 round/agent_turn；nextRound 递增 | 单测（`:memory:` SQLite）|
| **EndowmentPolicy** | 反比公式：免费→K/floor 上限、贵→小额、floor 防除零 | 纯单测 |
| **OddsPolicy** | 难度档 1.5/3/5；task.odds 覆盖 | 纯单测 |
| **SettlementPolicy** | 成功 +S×(O−1)、部分 +S×(O−1)×(2c−1)、重大错误 −S/−S×O、任务税 | 纯单测（验算）|
| **CostModel** | token×单价×倍率 + Σ(工具权重×时长×资源因子) + 延迟×倍率 | 纯单测 |
| **bid 解析** | 回复→stake 解析、截断到可用余额、非法→0 | 纯单测（mock 回复）|
| **Market 编排** | allocate 选最大押注/冻结/建 task/分配 round；settle 应用 D−U/解冻/更新余额/agent_turn；fail-open（BiddingPolicy 抛错→回退）；stake 截断 | 集成测试（mock BiddingPolicy + 内存 Ledger）|
| **mode 钩子 / 命令** | classic/market 分流、`/lab mode`、`/lab arena *` | 手动冒烟 |
| **端到端** | market 模式派发 → 征 bid → 中标派发 → 结算 → 排行榜/轮次更新 | 手动 e2e |

> BiddingPolicy 真实模型调用在单测中 mock；框架 `node --test`。

## 10. 与后续子项目的衔接（身份渐进涌现）

| 子项目 | 内容 | 复用/扩展 |
|--------|------|-----------|
| **Arena-2 记忆空间** | per-agent 记忆，任务后更新 | `AgentState.memory`；身份 +1 维 |
| **Arena-3 换模型/求知识市场** | 花 credits 换基底/注入知识 | M2 apply；`AgentState.knowledge` 雏形 |
| **Arena-4 破产+知识商店** | 破产→不良资产回收→出售 | Ledger 负债/清算；`AgentState.knowledge` |
| **Arena-5 赔率遥测反推+探索治理** | OddsPolicy 换实现；马太效应治理 | `OddsPolicy` 可插拔 |
| **Arena-6 次级市场/分包** | agent 分包、嵌套市场 | `Market` 可嵌套（深度上限）|
| **Arena-7 聘用工作流** | Classic 聘用组流水线 | pi-subagents chain + 信用承诺 |
| **Arena-8 合作并行+Judge 分润** | 多 agent 同做+合并+分润 | `Judge` 接口；`SettlementPolicy` 利润分成 |
| **Arena-9 Lab Dashboard TUI** | `/lab launch` 监控经济+agent 状态 | `ctx.ui.custom`；round/agent_turn 数据 + credit_snapshot |

## 11. 实现期需验证的开放问题

1. **bid 轻量模型调用**：经 pi-ai / `ctx.modelRegistry` 直接调用候选模型的具体 API（注入、超时、解析），实现时确认。
2. **`/lab arena post` 内派发 subagent**：命令处理器内程序化派发 subagent 的机制（`pi.sendUserMessage` 或 subagent 工具），实现时确认。
3. **toolCalls 时长 / 推理延迟来源**：从 `tool_execution_*` 事件与 message usage/计时提取 `durationMs`、`inferenceLatencyMs` 的确切字段，实现时核对。
4. **majorError 判定**：v1 由何信号判定"重大错误"（isError / acceptance=none / interrupted），实现时明确（建议：`isError || acceptance==="none"`）。
5. **mode 切换持久化**：`/lab mode` 写 `config.json` 的 `mode` 键，重启后保持。

## 12. 本子项目内分期建议

- **1a**：`arena/types.ts` + `ledger.ts`（含 round/agent_turn）+ Ledger 单测
- **1b**：`policies.ts`（Endowment/Odds/Settlement/CostModel + 单测）+ bid 解析
- **1c**：`market.ts`（Market 编排）+ 集成测试（mock）
- **1d**：`BiddingPolicy` v1（真实轻量模型调用）
- **1e**：`register.ts`（mode 感知钩子 + `/lab arena` 命令 + `/lab mode`）+ 手动 e2e
