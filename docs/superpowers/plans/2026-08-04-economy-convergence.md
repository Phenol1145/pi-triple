# Implementation Plan: 经济层 D4 收敛 + 真实 LLM 冒烟

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** D3 遗留收敛（双字段命名/negativeFlow 移除）+ 交付真实 LLM 冒烟（1 任务市场闭环，最小调用量）。

**Architecture:** 全部在 `extensions/agent-lab`（node:test，`.ts` 后缀，零新增依赖——冒烟脚本用 node 内建 fetch + node:sqlite）。冒烟 LLM = DeepSeek API 直连，凭据复用 pi `modelRegistry.getApiKeyForProvider()`。

**裁决（brainstorm 2026-08-04）**：
- 范围 = 代码收敛（双字段 + negativeFlow）+ 真实冒烟
- 冒烟 = 跑最小（1 任务闭环）；后端 DeepSeek 直连；凭据复用 pi registry
- 冒烟是独立脚本（bench/ 或 examples/），不进 node:test 套件（避免 CI 误触真实 LLM 调用）

**前置事实（已探明）**：
- 双字段：`currency.buy_voucher` 事件 data 双发 `cost`+`creditCost`（同值）；投影读 `cost`（projections.ts:118）。收敛 = 删 projections.ts 的 `cost` 读为 `creditCost`，buy 发射去 `cost` 字段，同步改投影测试事件数据。
- negativeFlow：settlement.ts 定义（:46）+ 赋值（:152-165）；experience.ts 不消费；market-effects.ts applySettlement 不读（从 reviewerSettles 全量迭代）。**B 彻底方案**：从 SettlementPlan 移除字段，删除赋值逻辑，删除 Task 4 加的防御断言（防御对象消失），改测试（market-settlement 5b 单槽断言）。
- spawn* 接口（market-runner.ts:74-80）：`spawnBidder/spawnReviewer/spawnExecutor` 注入——生产 = 真实 LLM 调用。冒烟注入真实 DeepSeek 调用。
- 冒烟 1 任务闭环 = 1 announce + N bid + 1 execute + M review + 1 settle——最小 LLM 调用 = N(bid) + 1(execute) + M(review)。v1 冒烟可 mock bid/review 确定性桩、仅 execute 真实 LLM？——**裁决**：冒烟核心验证"市场闭环 + 真实 LLM 执行"，bid/review 可用规则桩（确定性）降额度，execute 用真实 LLM（1 次调用）。

---

## Task 1: 双字段命名收敛（删 cost，统 creditCost）

**Files:**
- Modify: `extensions/agent-lab/src/economy/voucher-port.ts`（buy 发射去 `cost` 字段）
- Modify: `extensions/agent-lab/src/economy/projections.ts`（读 `creditCost`）
- Modify: `extensions/agent-lab/test/projections.test.ts` + `economy-voucher.test.ts` + `market-integration.test.ts`（事件数据同步）

**Step 1: 失败测试**

```ts
// buy_voucher 事件 data 不再含 cost 字段（只 creditCost）
const ev = bus.drain().find(e => e.kind === "currency.buy_voucher");
expect("cost" in ev.data).toBe(false);
expect(ev.data.creditCost).toBe(units * rate);
// 投影对账仍正确（读 creditCost）——projectEconomy voucherStock/creditValue 不变
```

**Step 2: 实现**

① voucher-port.ts buy 发射 `data: { agentId, kind, units, creditCost: cost }`（删 `cost`）。
② projections.ts `currency.buy_voucher` 分支 `num(d, "cost")` → `num(d, "creditCost")`。
③ 测试事件数据 `cost` → `creditCost`（projections.test.ts 4 处 + 其余）。

**裁决**：单一字段 `creditCost`（与 burn 事件 creditCost 对齐——Task 11 已用）；projections.test.ts 的 `currency.buy_voucher` 测试事件数据同步改。

**Step 3: 全绿 + commit**

`refactor(economy): buy_voucher 事件统一 creditCost（删 cost 双发——命名收敛）`

---

## Task 2: negativeFlow 移除（B 彻底方案）

**Files:**
- Modify: `extensions/agent-lab/src/economy/settlement.ts`（删字段 + 赋值）
- Modify: `extensions/agent-lab/src/economy/market-effects.ts`（删 Task 4 防御断言——防御对象消失）
- Modify: `extensions/agent-lab/test/market-settlement.test.ts` + `market-effects.test.ts`（删单槽断言）

**Step 1: 失败测试**

```ts
// SettlementPlan 不再含 negativeFlow 字段
const plan = planSettlement({...负流场景...});
expect("negativeFlow" in plan).toBe(false);
// 负流路由仍全量正确（reviewerSettles 全量迭代——Task 4 测试保留）
```

**Step 2: 实现**

① settlement.ts 删 `negativeFlow` 字段（interface）+ 赋值逻辑（:152-165）+ JSDoc/模块头注释。
② market-effects.ts 删 Task 4 加的防御断言（routed vs total 同源对比——防御对象 negativeFlow 已消失，断言无意义）。
③ market-settlement.test.ts 删 5b 单槽断言（negativeFlow.amount）；market-effects.test.ts 若引 negativeFlow 同步删。

**裁决**：Task 4 的多负流全量路由测试（5b/5c）保留——它们锁"全量路由"而非 negativeFlow；只删 negativeFlow 字段相关断言。编译期检查：`rg negativeFlow` 应零命中（除注释）。

**Step 3: 全绿 + commit**

`refactor(economy): negativeFlow 单槽字段移除（B 彻底方案——负流唯一路由源 reviewerSettles）`

---

## Task 3: 真实 LLM 冒烟（1 任务市场闭环 + runbook）

**Files:**
- Create: `extensions/agent-lab/examples/market-smoke.ts`（冒烟脚本——node 直跑，非 node:test）
- Create: `docs/superpowers/runbooks/2026-08-04-market-smoke.md`（冒烟手册）
- Reference（不改）: market-runner.ts（MarketRunner 注入真实 spawn*）

**冒烟设计（裁决）**：
- **1 任务闭环**：announce → 2 bidder（规则桩确定性 stake）→ select → execute（**真实 DeepSeek LLM 1 次调用**）→ 3 reviewer（规则桩确定性 score）→ consensus → settle → apply_settlement。
- **仅 execute 真实 LLM**（1 次调用，最小额度）：spawnExecutor 调 DeepSeek chat API 生成任务交付物（如"写一个两数之和函数"）；bid/review 用确定性规则桩（stake/score 固定——降额度且闭环可复现）。
- **凭据**：`modelRegistry.getApiKeyForProvider()` 复用 pi registry；或 `process.env.DEEPSEEK_API_KEY` 兜底。DeepSeek endpoint `https://api.deepseek.com/chat/completions`，model `deepseek-chat`。
- **真实依赖**：node:sqlite 内存库（MarketStore/SqliteLedger/SqliteVoucher/EconomyEventBus 共享 db）；MarketRunner 全依赖注入。
- **输出**：闭环各阶段余额/事件流/投影报告 + LLM 交付物摘要——打印观测，断言市场闭环完成（资金守恒 + 任务 settled）。
- **runbook**：前置（DEEPSEEK_API_KEY / registry 配置）+ 运行命令 + 预期输出 + 故障排查（429/额度/网络）。

**Step 1: 冒烟脚本骨架（可本地 mock LLM 先跑通闭环，再切真实）**

```ts
// examples/market-smoke.ts — node --experimental-strip-types examples/market-smoke.ts
// 模式：SMOKE_LLM=1 真实 DeepSeek（execute）；默认 mock（零额度，先验证闭环）
const useLLM = process.env.SMOKE_LLM === "1";
// … MarketRunner 装配 + spawnExecutor 按 useLLM 切真实/桩
```

**Step 2: 实现**

① 冒烟脚本：装配共享 db + 全依赖（MarketStore/Ledger/Voucher/CalibrationPool/OrgMembership/EventBus）+ MarketRunner + 注入 spawn*（execute 真实 LLM / bid·review 规则桩）。
② DeepSeek 调用：`fetch("https://api.deepseek.com/chat/completions", { method, headers: { Authorization: `Bearer ${key}` }, body })`——凭据 `await getApiKey()`（registry 或 env）。
③ runbook 手册（前置/运行/预期/排查）。
④ **实际跑 1 次真实冒烟**（SMOKE_LLM=1）验证闭环 + 记录输出到 runbook。

**裁决**：冒烟脚本**不进 node:test 套件**（独立 examples/，避免 CI 误触真实调用）；默认 mock 模式（SMOKE_LLM 缺省 → 零额度闭环验证），SMOKE_LLM=1 才真实 LLM。

**Step 3: 验证 + commit**

`feat(economy): 真实 LLM 冒烟脚本 + runbook（1 任务闭环——DeepSeek execute 真实调用，bid/review 规则桩最小额度）`

---

## Global Constraints
- Task 1/2（代码收敛）：失败测试 → 实现 → 全绿 → commit；基线 agent-lab 1636 pass / 2 pre-existing；PTL 717/717
- Task 3（冒烟）：独立 examples/ 脚本（非 node:test）；默认 mock 零额度；SMOKE_LLM=1 真实
- 零新增依赖；import `.ts` 后缀；node:test（收敛任务）
- 冒烟实际跑需用户提供 DEEPSEEK_API_KEY（或 pi registry 已配置）——协调者在 Task 3 与用户确认后执行
