# Agent Arena §11.1 修复 — 让 Market 真正竞价（pi-ai 调用 + 可插拔竞价者选择）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 §11.1：让 Market 模式真正向候选模型征 bid。根因是 `makeModelCaller` 用错了 pi-ai 入口（完成函数在 `@earendil-works/pi-ai/compat`，需 `Model` 对象 + 鉴权 + `Context{messages}`）。修复：用 `ctx.modelRegistry` 解析模型/鉴权，调 `complete()`；并把"选哪些候选参与竞价"抽象为可插拔 `BidderSelector`（v1：TopBalance / Random），每次只征询 `market.maxBidders` 个候选。

**Architecture:** 纯逻辑模块（market/bidding/policies）通过**参数**接收 `caller`（ModelCaller）与 `selector`（BidderSelector），保持无 pi 依赖；`createModelCaller(ctx)` 是胶水（pi-ai + ctx.modelRegistry），由拦截器在派发时创建并传入。Market.allocate 先用 selector 选 N 个候选，再只对这 N 个征 bid（其余本轮不参与、不扣税）。

**Tech Stack:** TypeScript（pi jiti）；`@earendil-works/pi-ai/compat` 的 `complete` + 主入口 `contentText`；`ctx.modelRegistry`（find/hasConfiguredAuth/getApiKeyAndHeaders）；`node:test`。

## Global Constraints

- Node ≥ 22.5；相对导入用 `.ts` 扩展名。
- 纯模块（`arena/market.ts`、`arena/bidding.ts`、`arena/policies.ts`、`arena/ledger.ts`）**不得** import pi；它们通过参数接收 `caller`/`selector`。
- `arena/model-caller.ts` 是**胶水**（允许 import pi-ai 与 `@earendil-works/pi-coding-agent` 类型），与 `*/register.ts`、`index.ts` 同类。
- fail-open：模型解析/鉴权/调用失败 → 该候选 stake 0；Market 分配失败 → 回退 Classic。
- 只有**被征询却弃接**（stake 0）的候选扣任务税；未被选中的候选本轮不扣税。
- 测试命令：`node --experimental-strip-types --test test/*.test.ts`。每任务结尾单独 commit。

---

## File Structure

```
src/arena/types.ts        # (改) +ModelCaller +BidderSelector；BiddingPolicy.solicitBids 增 caller?；Market.allocate 增 caller?；ArenaConfig.market +maxBidders +bidderSelector
src/config.ts             # (改) DEFAULT_ARENA_CONFIG.market +maxBidders:6 +bidderSelector:"top-balance"
src/arena/policies.ts     # (改) +TopBalanceSelector +RandomSelector；BiddingPolicyV1 构造改为(cfg)，solicitBids 用传入 caller
src/arena/model-caller.ts # (新, 胶水) createModelCaller(ctx)：pi-ai compat complete + ctx.modelRegistry
src/arena/market.ts       # (改) MarketDeps +selector；allocate(task, caller?) 先选 N 再征 bid
src/interceptor/register.ts # (改) market 分支 createModelCaller(ctx) + market.allocate(task, caller)
index.ts                  # (改) 删 makeModelCaller；按配置建 selector；BiddingPolicyV1(cfg.arena)；MarketV1({…,selector})
test/arena-selectors.test.ts # (新) TopBalance/Random selector 单测
test/arena-market.test.ts    # (改) mkMarket 增 selector；allocate 签名
test/arena-bidding.test.ts   # (改) BiddingPolicyV1(cfg)；solicitBids(task,c,caller)
```

---

## Task G1: 增量新代码（接口/选择器/模型调用器/配置，不破坏现有构建）

**Files:**
- Modify: `src/arena/types.ts`、`src/config.ts`、`src/arena/policies.ts`
- Create: `src/arena/model-caller.ts`、`test/arena-selectors.test.ts`

**Interfaces:**
- Produces: `ModelCaller`、`BidderSelector` 接口；`TopBalanceSelector`/`RandomSelector`；`createModelCaller(ctx)`；`ArenaConfig.market.maxBidders/bidderSelector` + 默认值。
- 注意：本任务**不改** `BiddingPolicy.solicitBids`/`Market.allocate` 现有签名（留给 G2），故现有构建保持可用。

- [ ] **Step 1: 改 src/arena/types.ts（仅新增，不改现有签名）**

在文件中新增（`ModelCaller`、`BidderSelector` 接口；`ArenaConfig.market` 增两字段）：
```ts
export interface ModelCaller {
  complete(model: string, prompt: string, timeoutMs: number): Promise<string>;
}

export interface BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[];
}
```
并把 `ArenaConfig`（在 `src/types.ts` 中）的 `market` 子对象类型扩展为含 `maxBidders: number; bidderSelector: string;`。
> 注：`ArenaConfig` 定义在 `src/types.ts`（非 arena/types.ts）。在 `src/types.ts` 的 `ArenaConfig.market` 里加 `maxBidders: number; bidderSelector: string;`。

- [ ] **Step 2: 改 src/config.ts（DEFAULT_ARENA_CONFIG.market 增默认值）**

将 `DEFAULT_ARENA_CONFIG` 的 `market` 改为：
```ts
  market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance" },
```
（`mergeArena` 已对 `market` 做 `{...base.market, ...partial.market}` 展开，新字段自动合并，无需改 mergeArena。）

- [ ] **Step 3: 改 src/arena/policies.ts（新增两个 selector，暂不改 BiddingPolicyV1）**

在文件末尾新增：
```ts
import type { AgentState, BidderSelector } from "./types.ts";

export class TopBalanceSelector implements BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[] {
    return [...candidates].sort((a, b) => b.balance - a.balance).slice(0, Math.max(0, n));
  }
}

export class RandomSelector implements BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[] {
    const arr = [...candidates];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, Math.max(0, n));
  }
}
```
（把 `AgentState`、`BidderSelector` 并入文件顶部已有的 `./types.ts` import。）

- [ ] **Step 4: 创建 src/arena/model-caller.ts（胶水）**

```ts
import { complete } from "@earendil-works/pi-ai/compat";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelCaller } from "./types.ts";

export function createModelCaller(ctx: ExtensionContext): ModelCaller {
  const reg = ctx.modelRegistry;
  return {
    async complete(modelId: string, prompt: string, timeoutMs: number): Promise<string> {
      let model = reg.find("openrouter", modelId);
      if (!model && modelId.includes("/")) {
        const idx = modelId.indexOf("/");
        model = reg.find(modelId.slice(0, idx), modelId.slice(idx + 1));
      }
      if (!model) throw new Error("model not in registry: " + modelId);
      if (!reg.hasConfiguredAuth(model)) throw new Error("no configured auth: " + modelId);
      const auth = await reg.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error("auth failed: " + auth.error);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const msg = await complete(model as never, { messages: [{ role: "user", content: prompt }] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctrl.signal });
        return contentText(msg.content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 5: 创建 test/arena-selectors.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TopBalanceSelector, RandomSelector } from "../src/arena/policies.ts";
import type { AgentState } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

function st(agent: string, balance: number): AgentState {
  const model: ModelInfo = { id: agent, provider: agent.split("/")[0], name: agent, accessRoute: "free" };
  return { agent, model, balance };
}
const candidates = [st("m/a", 100), st("m/b", 500), st("m/c", 300), st("m/d", 200)];

test("TopBalanceSelector picks top N by balance desc", () => {
  const sel = new TopBalanceSelector().select(candidates, 2);
  assert.deepEqual(sel.map((s) => s.agent), ["m/b", "m/c"]);
});

test("TopBalanceSelector N > length returns all", () => {
  const sel = new TopBalanceSelector().select(candidates, 10);
  assert.equal(sel.length, 4);
});

test("RandomSelector returns exactly N distinct candidates", () => {
  const sel = new RandomSelector().select(candidates, 3);
  assert.equal(sel.length, 3);
  assert.equal(new Set(sel.map((s) => s.agent)).size, 3);
  for (const s of sel) assert.ok(candidates.some((c) => c.agent === s.agent));
});

test("selectors with N=0 return empty", () => {
  assert.equal(new TopBalanceSelector().select(candidates, 0).length, 0);
  assert.equal(new RandomSelector().select(candidates, 0).length, 0);
});
```

- [ ] **Step 6: 运行测试 + 加载冒烟**

Run:
```bash
node --experimental-strip-types --test test/*.test.ts
node --experimental-strip-types -e "import('./src/arena/model-caller.ts').then(()=>console.log('model-caller loads')).catch(e=>console.error('EXPECTED pi-ai offline?', e.message))"
```
Expected: 全量测试通过（58 + 4 selector = 62）；model-caller 加载（pi-ai 在 pi 运行时可解析；离线若报 pi-ai 解析错误属预期，记录即可）。

- [ ] **Step 7: Commit**

```bash
git add src/arena/types.ts src/types.ts src/config.ts src/arena/policies.ts src/arena/model-caller.ts test/arena-selectors.test.ts
git commit -m "feat(arena): BidderSelector (top-balance/random) + createModelCaller (pi-ai compat) + maxBidders config"
```

---

## Task G2: 集成重构（接通 caller/selector，同步更新所有用法与受影响测试）

**Files:**
- Modify: `src/arena/types.ts`、`src/arena/policies.ts`、`src/arena/market.ts`、`src/interceptor/register.ts`、`index.ts`、`test/arena-market.test.ts`、`test/arena-bidding.test.ts`

**Interfaces:**
- `BiddingPolicy.solicitBids(t, c, caller?)`；`Market.allocate(t, caller?)`；`MarketV1` 构造增 `selector`；`BiddingPolicyV1(cfg)`。

- [ ] **Step 1: 改 src/arena/types.ts 签名**

```ts
export interface BiddingPolicy { solicitBids(t: ArenaTask, c: AgentState[], caller?: ModelCaller): Promise<Bid[]>; }
```
```ts
export interface Market {
  allocate(t: ArenaTask, caller?: ModelCaller): Promise<MarketAllocation | undefined>;
  settle(taskId: string, o: Outcome): void;
}
```

- [ ] **Step 2: 改 src/arena/policies.ts 的 BiddingPolicyV1**

把 `BiddingPolicyV1` 改为（构造去掉 caller，solicitBids 用传入 caller；无 caller → 全 stake 0）：
```ts
export class BiddingPolicyV1 implements BiddingPolicy {
  private cfg: ArenaConfig;
  constructor(cfg: ArenaConfig) { this.cfg = cfg; }
  async solicitBids(t: ArenaTask, candidates: AgentState[], caller?: ModelCaller): Promise<Bid[]> {
    if (!caller) return candidates.map((c) => ({ agent: c.agent, stake: 0 }));
    const out: Bid[] = [];
    for (const c of candidates) {
      const available = c.balance;
      const prompt = renderBidPrompt(this.cfg.bidding.promptTemplate, { prompt: t.prompt, role: t.role, difficulty: String(t.difficulty), odds: t.odds, balance: available });
      try {
        const reply = await caller.complete(c.model.id, prompt, this.cfg.bidding.timeoutMs);
        out.push({ agent: c.agent, stake: parseBidResponse(reply, available) });
      } catch {
        out.push({ agent: c.agent, stake: 0 });
      }
    }
    return out;
  }
}
```
（确保 `ModelCaller` 已并入 `./types.ts` import。）

- [ ] **Step 3: 改 src/arena/market.ts**

`MarketDeps` 增 `selector: BidderSelector`（import `BidderSelector`、`ModelCaller`）。`allocate` 改签名并先选 N 个再征 bid（只对 selected 扣弃接税）：
```ts
  async allocate(t: ArenaTask, caller?: ModelCaller): Promise<MarketAllocation | undefined> {
    const { ledger, catalog, bidding, odds, cfg, selector } = this.deps;
    const candidates = catalog.candidates();
    if (candidates.length === 0) return undefined;
    const round = ledger.nextRound();
    const task: ArenaTask = { ...t, odds: odds.odds(t) };
    const states: AgentState[] = candidates.map((m) => {
      ledger.ensureEndowed(m.id, m);
      return { agent: m.id, model: m, balance: ledger.balance(m.id) };
    });
    const selected = selector.select(states, cfg.arena.market.maxBidders);
    let bids;
    try {
      bids = await bidding.solicitBids(task, selected, caller);
    } catch {
      return undefined;
    }
    const byAgent = new Map(selected.map((s) => [s.agent, s]));
    const bidMap = new Map(bids.map((b) => [b.agent, b.stake]));
    if (cfg.arena.settlement.tax > 0) {
      for (const s of selected) {
        if ((bidMap.get(s.agent) ?? 0) <= 0) ledger.debit(s.agent, cfg.arena.settlement.tax, "opt-out-tax", task.id, round);
      }
    }
    const eligible = bids
      .map((b) => {
        const st = byAgent.get(b.agent);
        if (!st) return undefined;
        const stake = Math.min(Math.max(0, b.stake), st.balance);
        return stake > 0 ? { agent: b.agent, stake, balance: st.balance } : undefined;
      })
      .filter((x): x is { agent: string; stake: number; balance: number } => !!x);
    if (eligible.length === 0) return undefined;
    eligible.sort((a, z) => (z.stake - a.stake) || (z.balance - a.balance) || (a.agent < z.agent ? -1 : 1));
    const winner = eligible[0];
    ledger.freeze(winner.agent, winner.stake, task.id);
    ledger.createTask(task, winner.agent, winner.stake, round);
    return { winner: winner.agent, model: winner.agent, stake: winner.stake, taskId: task.id, round };
  }
```
（`settle` 不变。）

- [ ] **Step 4: 改 src/interceptor/register.ts 的 market 分支**

顶部 import：`import { createModelCaller } from "../arena/model-caller.ts";`
把 market 分支中：
```ts
        const alloc = await market.allocate(task).catch(() => undefined);
```
改为：
```ts
        const caller = createModelCaller(ctx);
        const alloc = await market.allocate(task, caller).catch(() => undefined);
```

- [ ] **Step 5: 改 index.ts**

- 删除整个 `makeModelCaller` 函数。
- import 增 `TopBalanceSelector, RandomSelector`（来自 `./src/arena/policies.ts`），去掉 `type ModelCaller` import（若不再用）。
- 在创建 `market` 之前加：
```ts
  const selector = cfg.arena.market.bidderSelector === "random" ? new RandomSelector() : new TopBalanceSelector();
```
- `MarketV1` 构造改为：
```ts
  const market = new MarketV1({
    ledger, catalog,
    bidding: new BiddingPolicyV1(cfg.arena),
    odds: new OddsPolicyV1(cfg.arena),
    settlement: new SettlementPolicyV1(cfg.arena),
    costModel: new CostModelV1(cfg.arena),
    cfg,
    selector,
  });
```

- [ ] **Step 6: 改 test/arena-market.test.ts**

- import 增 `TopBalanceSelector`（来自 `../src/arena/policies.ts`）。
- `mkMarket` 的 `MarketV1` 构造增 `selector: new TopBalanceSelector()`。
- `allocate(task)` 调用保持不变（caller 可选；fixedBidding 忽略 caller）。

- [ ] **Step 7: 改 test/arena-bidding.test.ts**

- `new BiddingPolicyV1(cfg, caller)` 改为 `new BiddingPolicyV1(cfg)`。
- `bp.solicitBids(task, [...])` 改为 `bp.solicitBids(task, [...], caller)`。
- 增一个测试：无 caller 时全 stake 0：
```ts
test("BiddingPolicyV1 without caller -> all stake 0", async () => {
  const bp = new BiddingPolicyV1(cfg);
  const bids = await bp.solicitBids(task, [{ agent: "m/a", model: model("m/a"), balance: 1000 }]);
  assert.equal(bids[0].stake, 0);
});
```

- [ ] **Step 8: 运行全量测试 + 加载冒烟**

Run:
```bash
node --experimental-strip-types --test test/*.test.ts
node --experimental-strip-types -e "import('./index.ts').then(()=>console.log('index loads (type-only)')).catch(e=>console.error('EXPECTED typebox/pi-ai offline:', e.message))"
```
Expected: 全量测试通过（约 63）；index 离线仅因 typebox/pi-ai 报错（预期）。

- [ ] **Step 9: Commit**

```bash
git add src/arena/types.ts src/arena/policies.ts src/arena/market.ts src/interceptor/register.ts index.ts test/arena-market.test.ts test/arena-bidding.test.ts
git commit -m "feat(arena): wire caller+selector into Market bidding (§11.1 fix)"
```

---

## Task G3: 实测竞价（运行时验证）

**Files:** 无代码改动（验证 + 必要时微调）

- [ ] **Step 1: 清空/标记市场数据库基线**

记录当前 `market_tasks`/`credit_tx` 行数（应已含上次 opt-out 记录；关注新增）。

- [ ] **Step 2: 在 pi TUI（market 模式）派发一个 subagent，触发真实竞价**

由控制器/用户在 market 模式派发一个 subagent。观察：
- 若 pi-ai 调用成功：`market_tasks` 应新增一行（有 winner/stake/odds），`credit_tx` 有 `settle`/`opt-out-tax` 记录，`credits` 余额变化。
- 若 pi-ai 调用失败（签名/解析问题）：会 fail-open 回退 Classic，`market_tasks` 不增——此时需根据错误微调 `createModelCaller`（如 pi-ai message/options 格式）。

- [ ] **Step 3: 查数据库验证**

```bash
node --experimental-strip-types -e "import('node:sqlite').then(({DatabaseSync})=>{const db=new DatabaseSync(process.env.HOME+'/.pi/agent/agent-lab/agent-lab.db');console.log('tasks:',JSON.stringify(db.prepare('SELECT task_id,round,winner,stake,odds,status FROM market_tasks ORDER BY rowid DESC LIMIT 3').all()));console.log('recent tx:',JSON.stringify(db.prepare('SELECT agent,delta,reason FROM credit_tx ORDER BY id DESC LIMIT 8').all()));})"
```
Expected: 有新 `market_tasks` 行（winner 非空、status settled）→ 竞价真正发生。

- [ ] **Step 4: 若竞价成功，commit 任何微调；否则报告 BLOCKED/需进一步调试**

如 `createModelCaller` 需微调（pi-ai 格式），修改后重测并 commit：
```bash
git add src/arena/model-caller.ts
git commit -m "fix(arena): adjust createModelCaller pi-ai call format (verified live)"
```

---

## Self-Review（计划自检）

- **覆盖**：根因修复（pi-ai compat + ctx.modelRegistry）G1/G2；可插拔 BidderSelector（top-balance/random）+ maxBidders G1；接通 caller/selector G2；实测 G3。
- **占位符**：无 TBD/TODO；每步含完整代码与命令/预期。
- **一致性**：`BiddingPolicy.solicitBids(t,c,caller?)`、`Market.allocate(t,caller?)`、`MarketV1{…selector}`、`BiddingPolicyV1(cfg)` 在 G1/G2 一致；受影响测试（arena-market/arena-bidding）在 G2 同步更新。
- **纯/胶水边界**：market/bidding/policies 经参数接收 caller/selector（无 pi import）；model-caller.ts 为胶水（pi-ai + ctx）。
- **运行时不确定性**：pi-ai `complete` 的 message/options 格式需 G3 实测验证；fail-open 保证失败回退 Classic。
