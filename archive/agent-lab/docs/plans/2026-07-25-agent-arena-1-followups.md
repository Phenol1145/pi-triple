# Agent Arena-1 遗留补全 (a/c/d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 Arena-1 三项遗留：(a) §11.3 用量提取——用 subagent 工具调用时长作为 `inferenceLatencyMs`（内部工具明细 `toolCalls` 因父扩展不可见，留空并注明限制）；(c) `market.eligibility` 取值校验；(d) partial-completion 经 `MarketV1.settle` 的集成测试。

**Architecture:** (a) 在 telemetry 钩子增加 `tool_execution_start` 起始计时，`tool_execution_end` 算时长填入 Outcome.inferenceLatencyMs，使 CostModel 的 inferenceCost 生效。(c) applyArenaConfig 对 eligibility 做非空校验。(d) 复用现有 market 测试夹具补一个部分完成用例。

**Tech Stack:** TypeScript（pi jiti）；`node:test`；pi 扩展事件（tool_execution_start/end）。

## Global Constraints

- Node ≥ 22.5；相对导入用 `.ts` 扩展名。
- `telemetry/register.ts` 是胶水（`import type ExtensionAPI` 允许）；`arena/register.ts` 纯（无 pi import）。
- fail-open：telemetry 钩子 try/catch，绝不抛出/阻断派发。
- `b`（/lab arena post 自动派发）**不在本批**（用户决定 b3 暂缓，保留现有提示 stub）。
- `unfreeze` 按任务（e）**不在本批**（Arena-6/8）。
- 测试命令：`node --experimental-strip-types --test test/*.test.ts`。每任务结尾单独 commit。

---

## File Structure

```
src/telemetry/register.ts   # (改) 增 tool_execution_start 计时 + inferenceLatencyMs
src/arena/register.ts       # (改) market.eligibility 非空校验
test/arena-market.test.ts   # (改) 增 partial-completion settle 测试
```

---

## Task F1: inferenceLatencyMs（subagent 调用时长）

**Files:**
- Modify: `src/telemetry/register.ts`

**Interfaces:**
- Consumes: `tool_execution_start`/`tool_execution_end` 事件（均含 `toolCallId`）
- Produces: `Outcome.inferenceLatencyMs` = subagent 工具调用 wall-clock 时长（代理）；`toolCalls` 保持 `[]`（父扩展不可见子 agent 内部工具，spec §11.3 限制）。

- [ ] **Step 1: 替换 src/telemetry/register.ts 全文**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { Market, Outcome } from "../arena/types.ts";
import { parseSubagentRun } from "./parse.ts";

export function registerTelemetry(pi: ExtensionAPI, store: Store, cfg: LabConfig, market?: Market): void {
  const startTimes = new Map<string, number>();
  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "subagent") return;
    const id = String((event as { toolCallId?: unknown }).toolCallId ?? "");
    if (id) startTimes.set(id, Date.now());
  });
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "subagent") return;
    try {
      const taskId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
      const startedAt = taskId ? startTimes.get(taskId) : undefined;
      if (taskId) startTimes.delete(taskId);
      const inferenceLatencyMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : 0;
      const raw = event.result as { details?: unknown } | undefined;
      const result = (raw?.details ?? event.result) as Record<string, unknown>;
      const rec = parseSubagentRun({ input: (event.args ?? {}) as Record<string, unknown>, result }, cfg);
      if (rec) store.appendRun(rec);
      if (market && taskId) {
        const outcome: Outcome = {
          completion: rec?.completion ?? 0,
          majorError: Boolean((event as { isError?: unknown }).isError) || rec?.acceptance === "none",
          tokensIn: rec?.tokensIn ?? 0,
          tokensOut: rec?.tokensOut ?? 0,
          cost: rec?.cost ?? 0,
          toolCalls: [],   // v1: 子 agent 内部工具对父扩展不可见（spec §11.3 限制）
          inferenceLatencyMs,
        };
        market.settle(taskId, outcome);
      }
    } catch (err) {
      console.error("[agent-lab] telemetry failed:", err);
    }
  });
}
```

- [ ] **Step 2: 加载冒烟 + 全量测试**

Run:
```bash
node --experimental-strip-types -e "import('./src/telemetry/register.ts').then(()=>console.log('hooks load')).catch(e=>{console.error(e);process.exit(1);})"
node --experimental-strip-types --test test/*.test.ts
```
Expected: `hooks load`；全部测试通过（53）。

- [ ] **Step 3: Commit**

```bash
git add src/telemetry/register.ts
git commit -m "feat(arena): inferenceLatencyMs from subagent call duration (§11.3; toolCalls N/A from parent)"
```

---

## Task F2: eligibility 校验 (c) + partial-completion 测试 (d)

**Files:**
- Modify: `src/arena/register.ts`（`market.eligibility` 非空校验）
- Modify: `test/arena-market.test.ts`（增 partial-completion settle 测试）

**Interfaces:**
- Consumes: `applyArenaConfig` 现有结构；market 测试夹具（`mkMarket`/`fixedBidding`/`task`/`ENDOW_0_3`）。
- Produces: eligibility 空值被拒；partial-completion 结算被覆盖。

- [ ] **Step 1: 改 src/arena/register.ts 的 market.eligibility 分支**

将：
```ts
    case "market.eligibility": a.market.eligibility = val; return true;
```
改为：
```ts
    case "market.eligibility":
      if (!val.trim()) return false;
      a.market.eligibility = val.trim(); return true;
```

- [ ] **Step 2: 在 test/arena-market.test.ts 末尾追加 partial-completion 测试**

```ts
test("settle partial completion scales reward", async () => {
  const { ledger, market } = mkMarket([model("m/a"), model("m/b")], fixedBidding({ "m/a": 100, "m/b": 300 }));
  const res = await market.allocate(task);   // winner m/b, stake 300, O=3
  const partial: Outcome = { completion: 0.75, majorError: false, tokensIn: 0, tokensOut: 0, cost: 0, toolCalls: [], inferenceLatencyMs: 0 };
  market.settle(res!.taskId, partial);
  // D = S×(O−1)×(2c−1) = 300×2×0.5 = 300; U=0 -> balance = ENDOW_0_3 + 300
  assert.equal(ledger.balance("m/b"), ENDOW_0_3 + 300);
  assert.equal(ledger.getTask(res!.taskId)!.status, "settled");
});
```
（`Outcome` 已在该测试文件 import；若未 import 则补 `import type { ... Outcome ... } from "../src/arena/types.ts";`。）

- [ ] **Step 3: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/arena-market.test.ts`
Expected: PASS（5 个：原 4 + 新 1）。再跑全量 `test/*.test.ts` 确认 54 通过。

- [ ] **Step 4: Commit**

```bash
git add src/arena/register.ts test/arena-market.test.ts
git commit -m "fix(arena): validate market.eligibility + add partial-completion settle test"
```

---

## Self-Review（计划自检）

- **覆盖**：a(Task F1)、c(Task F2 step1)、d(Task F2 step2) 均有对应任务；b（b3 暂缓）与 e（Arena-6/8）明确排除。
- **占位符**：无 TBD/TODO；每步含完整代码与命令/预期。
- **一致性**：`Outcome` 字段（toolCalls/inferenceLatencyMs）与现有类型一致；测试复用现有夹具与常量 `ENDOW_0_3`。
- **已知限制**：`toolCalls` 父扩展不可见（§11.3），代码内已注释说明。
