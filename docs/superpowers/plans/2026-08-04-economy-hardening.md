# Implementation Plan: 经济层 D3 硬化（4 Important 修复）

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复最终 whole-branch review 的 4 个 Important：resume 窄窗凭证双燃 / 经验沉淀 ruleRef 落草稿 / buy_voucher 发射点挂空 / negativeFlow 单槽硬化。

**Architecture:** 全部在 `extensions/agent-lab`（node:test，`.ts` 后缀，零新增依赖）。不动记忆系统公共面（经验对齐既有公域 `rule:experience`）；凭证幂等复用 D1/D2 既有契约（traceId 业务键 + 业务幂等）。

**Tech Stack:** TypeScript（node:test）、node:sqlite、既有 memory/economy/voucher 模块。

**裁决（brainstorm 2026-08-04）**：
- 范围 = 4 Important 全包
- resume 双燃 = **凭证级幂等**（voucher_burns 业务键 traceId，与 effect 幂等同构）
- 经验 ruleRef = **对齐公域 `rule:experience`**（content 改行式管道格式——公域已种子该 grammar，word 原子支持任意字符串；不新增 grammar、不动 sink 端绕过校验）

**前置事实（已探明）**：
- `validateAgainstGrammar`（src/memory/ebnf.ts:306）是**行式管道格式校验**（逐行、`|` 分隔字段、EBNF 匹配）——非 JSON 校验器。
- 公域种子（src/assembly/public-bootstrap.ts:56）已有 `rule:experience = word ;`——ruleRef 指向它即可过校验。
- `SqliteVoucher.buy/burn` 在 voucher-port.ts——buy 无 buy_voucher 事件发射点（挂空）。
- `emitBurn`（market-effects.ts）在 execute 相位先于 `updateTask({status:"executing"})`——崩溃于两者之间 → resume 重放再燃。
- `SettlementPlan.negativeFlow`（settlement.ts）是单槽代表字段，effect 侧 `applySettlement` 从 `reviewerSettles` 全量迭代——脆弱双源。

---

## Task 1: 经验沉淀 ruleRef 对齐（行式管道格式）

**Files:**
- Modify: `extensions/agent-lab/src/economy/experience.ts`
- Test: `extensions/agent-lab/test/experience.test.ts`
- Verify（不修改）: `extensions/agent-lab/src/assembly/public-bootstrap.ts`

**Step 1: 失败测试**

```ts
// test 1: 沉淀 content 为行式管道格式（| 分隔字段）+ ruleRef="rule:experience"
const sink = { calls: [] as any[], write(p: any) { this.calls.push(p); return { ok: true, entry: p }; } };
sedimentExperiences(sink, { taskId: "t-1", experiences: [ /* 1 execution exp */ ] });
const call = sink.calls[0];
// content 应为行式（非 JSON）：含 "|" 分隔，无 "{"
expect(call.content).not.toContain("{");
expect(call.content.split("|").length).toBeGreaterThan(3);
expect(call.ruleRef).toBe("rule:experience");

// test 2: 行式 content 过公域 experience grammar 校验（word 原子）
import { parseEbnf } from "../src/memory/ebnf.ts";
const grammar = parseEbnf("experience = word ;");
if (grammar.ok) {
  const errs = validateAgainstGrammar(grammar.grammar, "experience", call.content);
  expect(errs).toEqual([]); // 单字段 word 匹配任意非空串——但需 content 单行
}

// test 3: 经验检索可读（字段语义保持——kind/agentId/outcome/reward 可在行式中复原或含于字段）
// 行式格式：`${kind}|${scene}|${agentId}|${action}|${outcome}|${reward}|${evaluationMode ?? "-"}`
expect(call.content).toContain("execution|");
```

**Step 2: 实现（minimal）**

`experience.ts` `sedimentExperiences`：content 从 `JSON.stringify(exp)` 改为行式管道格式：

```ts
// 行式管道格式（对齐公域 rule:experience = word；字段以 "|" 分隔）
// `${kind}|${scene}|${agentId}|${action}|${outcome}|${reward}|${evaluationMode ?? "-"}`
function experienceToLine(exp: SettlementExperience): string {
  const parts = [exp.kind, exp.scene, exp.agentId, exp.action, String(exp.outcome), String(exp.reward), exp.evaluationMode ?? "-"];
  return parts.join("|"); // 各字段本身不含 "|"（scene/agentId 来自系统生成的 id——裁决）
}

sink.write({
  idempotencyKey: `${exp.kind}:${args.taskId}:${exp.agentId}`,
  kind: "experience",
  ruleRef: "rule:experience",   // ← 新增：过公域 grammar 校验
  content: experienceToLine(exp), // ← 改：行式管道格式（对齐 validateAgainstGrammar 行式语义）
  anchors: [args.taskId, exp.scene, exp.agentId],
});
```

**裁决**：kind/scene/agentId 各字段系统生成，不含 `|`（若含需转义——v1 断言不含，测试覆盖）；evaluationMode 缺省 "-"；reward/outcome 数字字符串化。DSP 检索侧（`- [anchors] content`）渲染行式可读。

**Step 3: 全绿 + commit**

`feat(economy): 经验沉淀对齐公域 rule:experience（行式管道 content + ruleRef——真实落库非草稿区）`

---

## Task 2: resume 凭证双燃幂等（业务键 traceId）

**Files:**
- Modify: `extensions/agent-lab/src/economy/market-effects.ts`（emitBurn 幂等）
- Modify: `extensions/agent-lab/src/economy/market-runner.ts`（若需 execute 相位传 traceId）
- Test: `extensions/agent-lab/test/market-integration.test.ts`（补 resume 双燃场景）

**Step 1: 失败测试**

```ts
// 崩溃于 emitBurn 之后、updateTask(executing) 之前 → resume 不重复燃烧
// 第一次 run 燃 2 凭证后模拟崩溃（在 emitBurn 后注入崩溃点——若 runner 支持注入，或
// 直接调 emitBurn 两次同 traceId 断言第二次幂等）
// 断言：burnHistory 仅 2 条（非 4 条）；第二次 emitBurn 同 (taskId, executorId, kind) 幂等跳过
```

**Step 2: 实现（最小）**

`emitBurn` 幂等：燃烧前检查 `burnHistory()` 是否已存在同 `(taskId, executorId, kind, units)` 的燃烧记录（业务键）——存在则跳过（返回既有记录，不重复 burn）：

```ts
function emitBurn(deps, task, executorId, kind, units) {
  // 凭证级幂等：同任务同执行者同 kind 已燃 → 跳过（resume 重放不重复燃）
  const already = deps.voucher.burnHistory().some(
    (r) => r.taskId === task.taskId && r.agentId === executorId && r.kind === kind
  );
  if (already) { /* 取既有记录 creditCost 发事件（或直接跳过发射） */ return; }
  // … 既有燃烧 + 事件逻辑
}
```

**裁决**：业务键 = `(taskId, executorId, kind)`（一个任务一个执行者同 kind 只燃一次——voucherAllowance 一次燃烧模型）；burnHistory 记录含 taskId/agentId/kind（先确认字段——`emitBurn` 需从 record 读 creditCost）。若 burnHistory 字段缺 taskId/agentId 则需扩展 burn 记录载体（检查 voucher-port.ts burn 签名）。**实现前必读 emitBurn + burnHistory 现状确认字段**。

**Step 3: 全绿 + commit**

`fix(economy): 凭证燃烧业务键幂等（resume 重放不重复燃——窄窗双燃闭合）`

---

## Task 3: buy_voucher 发射点（SqliteVoucher.buy）

**Files:**
- Modify: `extensions/agent-lab/src/economy/voucher-port.ts`
- Test: `extensions/agent-lab/test/economy-voucher.test.ts`（补事件断言）或 market-integration

**Step 1: 失败测试**

```ts
// SqliteVoucher.buy 后 EconomyEventBus 收到 currency.buy_voucher（kind/agentId/units/creditCost）
// 投影 voucherStock/对账据此正确（不依赖手工注入）
```

**Step 2: 实现（最小）**

`SqliteVoucher.buy` 注入可选 `eventBus?: EconomyEventBus`（缺省无事件——向后兼容既有构造点）；buy 成功后 `eventBus?.emit("currency.buy_voucher", {...})`。**裁决**：构造点（Task 11 runner 接线）注入 eventBus；事件发射在 buy 的事务内（同事务——崩溃一致）或事务后（失败不回滚——事件可补）。**对齐 Task 4 裁决**：emitBurn 在事务内（先确认——读 emitBurn 实现）。

**Step 3: 全绿 + commit**

`feat(economy): SqliteVoucher.buy 发射 currency.buy_voucher（投影对账基源——跨层挂空闭合）`

---

## Task 4: negativeFlow 单槽硬化

**Files:**
- Modify: `extensions/agent-lab/src/economy/settlement.ts`（negativeFlow 语义硬化）
- Test: `extensions/agent-lab/test/market-settlement.test.ts`（补多负流场景断言 effect 路由正确）

**Step 1: 失败测试**

```ts
// 多负流场景：2 评审者负 settle → applySettlement 从 reviewerSettles 全量路由（非 negativeFlow 单槽）
// 断言：两个负流都被正确处理（各自余额扣回 + credit 对方）——防未来误用 negativeFlow
```

**Step 2: 实现（最小——二选一，D3 裁决选 A）**

**A. 硬化注释 + 断言（保守）**：settlement.ts `negativeFlow` 字段 JSDoc 显式标注"**仅展示用——effect 路由 MUST 从 reviewerSettles 全量迭代，MUST NOT 用此字段路由评审者负流**"；applySettlement 加防御断言（评审者负流计数 >1 时 negativeFlow 不代表全量——文档化）。**A 不破坏接口**。

**B. 移除 negativeFlow（彻底）**：从 SettlementPlan 删字段，effect 侧 derive。—— 破坏接口 + T9 experience 已消费？（检查）—— 若 experience.ts 用 negativeFlow 则 B 牵连。

**D3 裁决：A**（保守——字段保留但契约硬化；B 属 D4 接口清理，需查 experience.ts 是否消费）。

**Step 3: 全绿 + commit**

`fix(economy): negativeFlow 单槽契约硬化（展示用非路由源——防御多负流误用）`

---

## Global Constraints
- 每任务：失败测试 → 实现 → 全绿 → commit → 报告 `.superpowers/sdd/2026-08-04-economy-hardening/task-N-report.md`
- 基线：agent-lab 1624 pass / 2 pre-existing（weighted-scorer-bootstrap）；PTL 717/717
- 零新增依赖；import `.ts` 后缀；node:test
- 不动记忆系统公共面（Task 1 对齐既有 `rule:experience` 公域 grammar——零语法新增）
- Task 2/3 实现前必读现状（emitBurn/burnHistory/SqliteVoucher.buy 字段）确认业务键与字段载体
