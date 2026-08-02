# 装配层（子项目 C）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `createAgentAssembler` 把声明变成可运行经济主体（AgentRuntime）——记忆域初始化（fresh/fork）、开户（attempt-local 幂等）、注册持久、9+1 项接线契约落实。

**Architecture:** 新目录 `extensions/agent-lab/src/assembly/`（AgentAssembler/AgentRuntime/MemoryHost/RuleBootstrap/PublicDomainBootstrap/comms 桥接）+ 既有模块最小扩展（ledger removeAccount/runner 钩子/checkpoint latest/repository getAgent/PublicDomainStore 读访问器/RuleRegistry fallback）。装配产物目录 `<root>/agents/<agentId>/`；公域/规则库 `<root>/public-domain/` 全局共享。

**Tech Stack:** TypeScript（`--experimental-strip-types`，import 后缀 `.ts`）、node:test、node:sqlite（SqliteLedger）、node:fs（文件存储）。

## Global Constraints

- 零新增依赖；import 后缀 `.ts`；测试命令 `node --experimental-strip-types --test test/<file>.test.ts`
- 装配流程 6 步顺序逐字遵循 spec（`docs/superpowers/specs/2026-08-02-agent-assembly-design.md`）；9+1 项接线契约（spec §4 ①-⑩）全部有测试
- 续跑幂等 oracle = 注册记录预检（getAgent），余额不参与判定；removeAccount attempt-local（仅本调用创建）
- 规则库 = 公域 kind=rule 只读视图（RuleBootstrap 包装 PublicDomainStore，不建独立规则库目录）
- prune seq = resume 目标 checkpoint 的 seq；inbox ack（mergedAtSeq ≤ checkpoint seq 才删）+ msgId 去重
- 既有模块改动 = 最小只读/增量扩展（加方法不改行为；runner/ledger/checkpoints/repository 既有测试全绿）
- SQLite 迁移：created_round_id 保持 NOT NULL（哨兵 ""）；memory_spec/endowment 用 ALTER TABLE ADD COLUMN

---

### Task 1: 装配类型基座 + repository.getAgent 交付项

**Files:**
- Create: `extensions/agent-lab/src/assembly/types.ts`
- Modify: `extensions/agent-lab/src/core/storage/repository.ts`（+getAgent）
- Test: `extensions/agent-lab/test/assembly-types.test.ts`、`extensions/agent-lab/test/repository-get-agent.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface AgentRef { kind: "workloop"; id: string; version: string; }
export interface MemorySpec { dialect?: "json" | "xml" | "markdown"; maxEntries?: number; }  // markdown = draft-only
export interface AssembleOptions {
  cloneMode: "fresh" | "fork";
  sourceAgentId?: string;
  schedulerInstanceId: string;
  endowment?: { K: number; initialFloor: number };
  memory?: MemorySpec;
}
export const ASSEMBLY_DIR = "agents";           // <root>/agents/<agentId>/
export const PUBLIC_DOMAIN_DIR = "public-domain"; // <root>/public-domain/
export const ROUND_SENTINEL = "";               // createdAtRoundId 哨兵
export function validateMemorySpec(spec: MemorySpec | undefined): string[];  // 白名单/正整数/未知字段
```
- repository 新增：`getAgent(agentId: string): AgentInstanceRecord | undefined`（按 id 单查，SQL `WHERE id = ?`；repository 既有 agent 查询按 scheduler_instance_id——新方法独立）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-types.test.ts`）
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMemorySpec, ROUND_SENTINEL } from "../src/assembly/types.ts";

test("valid memory spec passes", () => {
  assert.deepEqual(validateMemorySpec({ dialect: "json", maxEntries: 100 }), []);
});
test("invalid dialect rejected", () => {
  assert.ok(validateMemorySpec({ dialect: "yaml" as never }).some((e) => e.includes("dialect")));
});
test("markdown dialect is allowed but documented draft-only", () => {
  assert.deepEqual(validateMemorySpec({ dialect: "markdown" }), []);
});
test("maxEntries must be positive integer", () => {
  assert.ok(validateMemorySpec({ maxEntries: 0 }).length > 0);
  assert.ok(validateMemorySpec({ maxEntries: -1 }).length > 0);
  assert.ok(validateMemorySpec({ maxEntries: 1.5 }).length > 0);
});
test("unknown fields rejected", () => {
  assert.ok(validateMemorySpec({ projection: {} } as never).length > 0);
});
test("ROUND_SENTINEL is empty string", () => {
  assert.equal(ROUND_SENTINEL, "");
});
```
- [ ] **Step 2: 运行确认失败** → FAIL（模块不存在）
- [ ] **Step 3: 实现** types.ts（按 Interfaces）；repository 加 getAgent（读 `test/repository-get-agent.test.ts` 前的既有测试模式——repository 测试用 DatabaseSync 临时库，参考既有 repository 测试文件）
- [ ] **Step 4: 全绿**：`node --experimental-strip-types --test test/assembly-types.test.ts test/repository-get-agent.test.ts`
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): 装配类型基座 + repository.getAgent 交付项"`

---

### Task 2: LedgerPort + SqliteLedger 扩展（removeAccount/open created/debit 抛错/freeze 映射）

**Files:**
- Create: `extensions/agent-lab/src/assembly/ledger-port.ts`
- Modify: `extensions/agent-lab/src/arena/ledger.ts`（+removeAccount）
- Test: `extensions/agent-lab/test/assembly-ledger-port.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface LedgerPort {
  open(agentId: string, initialK: number): { created: boolean };
  balance(agentId: string): number;
  credit(agentId: string, amount: number, reason: string): void;
  debit(agentId: string, amount: number, reason: string): void;   // 余额不足 → 抛错
  freeze(agentId: string, amount: number, reason: string): void;  // reason → taskId 派生键 `freeze:<agentId>:<reason>`；余额不足/false → 抛错
  unfreeze(agentId: string, reason: string): void;                // 整笔解冻
}
export class SqliteLedgerAdapter implements LedgerPort { /* 包装 SqliteLedger */ }
```
- ledger.ts 新增（最小增量）：
```typescript
removeAccount(agentId: string): void;   // DELETE FROM credits WHERE agent_id = ?（不存在 → no-op）
```
- Adapter 实现要点：open = 不存在 → 直接 INSERT（flat-K，绕过 ensureEndowed 模型价格）返回 {created:true}；已存在 → {created:false}；debit 检测 clamp（先 balance 再 debit，若 debit 后余额 < 0 或 debit 实际 < amt → 抛 `insufficient funds: <agentId>`——**实现用 balance 预检**：`if (balance < amt) throw`）；freeze 调 SqliteLedger.freeze 返回 false → 抛错；unfreeze 整笔（SqliteLedger.unfreeze(a, taskId)）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-ledger-port.test.ts`——用临时 sqlite 文件）
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-ledger-"));
  const db = new (await import("node:sqlite")).DatabaseSync(path.join(dir, "ledger.db"));
  const ledger = new SqliteLedger(db);
  return { ledger: new SqliteLedgerAdapter(ledger), db, dir };
}

test("open creates account with flat K and returns created", async () => {
  const { ledger, db, dir } = await fresh();
  assert.deepEqual(ledger.open("a1", 100), { created: true });
  assert.equal(ledger.balance("a1"), 100);
  assert.deepEqual(ledger.open("a1", 100), { created: false });  // 已存在 → 续跑信号
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("debit throws on insufficient funds", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  assert.throws(() => ledger.debit("a1", 20, "test"), /insufficient funds/);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("removeAccount deletes account (idempotent)", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  (ledger as { impl: SqliteLedger }).impl.removeAccount("a1");
  assert.equal(ledger.balance("a1"), 0);
  (ledger as { impl: SqliteLedger }).impl.removeAccount("a1");  // no-op
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("freeze maps reason to taskId key and throws on insufficient", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  ledger.freeze("a1", 5, "bid-1");
  ledger.unfreeze("a1", "bid-1");
  assert.throws(() => ledger.freeze("a1", 20, "bid-2"), /insufficient/);
  db.close(); rmSync(dir, { recursive: true, force: true });
});
```
- [ ] **Step 2: 运行确认失败** → FAIL（模块不存在；ledger.ts 无 removeAccount）
- [ ] **Step 3: 实现**：ledger-port.ts（LedgerPort + SqliteLedgerAdapter）；ledger.ts 加 removeAccount（DELETE，不存在 no-op）
- [ ] **Step 4: 全绿** + 既有 ledger 测试回归（`node --experimental-strip-types --test test/arena-ledger*.test.ts`）
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): LedgerPort + SqliteLedger 扩展（removeAccount/open created/debit 抛错/freeze 映射）"`

---

### Task 3: PublicDomainStore 读访问器 + PublicDomainBootstrap 种子

**Files:**
- Create: `extensions/agent-lab/src/assembly/public-bootstrap.ts`
- Modify: `extensions/agent-lab/src/memory/public-domain.ts`（+listOfficialEntries）
- Test: `extensions/agent-lab/test/assembly-public-bootstrap.test.ts`

**Interfaces:**
- Produces:
```typescript
export class PublicDomainBootstrap {
  constructor(private dir: string) {}   // <root>/public-domain/
  ensureInitialized(): void;            // 幂等：空库 → 写入公理 + 基础规则种子（kind=rule；tmp+rename 先写者胜）
}
```
- public-domain.ts 新增：
```typescript
listOfficialEntries(): MemoryEntry[];   // 公域全部 official 条目（status === "official"；遍历 entries/）
```
- 种子内容（PublicDomainBootstrap）：公理条目（id=AXIOM_RULE_ID, kind=axiom）+ 基础规则 fact（EBNF 模板，同记忆系统测试用 FACT_GRAMMAR）+ experience/preference 规则（word 型占位）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-public-bootstrap.test.ts`）
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { PublicDomainStore } from "../src/memory/public-domain.ts";

test("ensureInitialized seeds axiom + base rules idempotently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-pub-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  pb.ensureInitialized();   // 幂等（不重复）
  const store = new PublicDomainStore(dir);
  const entries = store.listOfficialEntries();
  assert.ok(entries.length >= 3);                     // 公理 + fact 规则 + experience/preference 规则
  assert.ok(entries.some((e) => e.kind === "axiom"));
  assert.ok(entries.filter((e) => e.kind === "rule").length >= 2);
  rmSync(dir, { recursive: true, force: true });
});
```
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：public-domain.ts 加 listOfficialEntries（读内部 MemoryStore——PublicDomainStore 已持 store 实例，`this.store.listIds()` + get + status 过滤）；public-bootstrap.ts（ensureInitialized 幂等：entries/ 非空 → 跳过；写入种子条目经 PublicDomainStore 内部 store 或直接 MemoryStore 写入——用 PublicDomainStore 的 submitWriteBack？不——bootstrap 是初始化，直接写内部 store（绕过审核，宿主初始化语义）；**实现细节**：PublicDomainBootstrap 直接构造 MemoryStore(dir) 写入种子（PublicDomainStore 内部布局一致））
- [ ] **Step 4: 全绿**
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): 公域读访问器 + PublicDomainBootstrap 幂等种子"`

---

### Task 4: RuleRegistry fallback + RuleBootstrap（公域 kind=rule 只读视图）

**Files:**
- Create: `extensions/agent-lab/src/assembly/rule-bootstrap.ts`
- Modify: `extensions/agent-lab/src/memory/rules.ts`（构造器加可选 fallback）
- Test: `extensions/agent-lab/test/assembly-rule-bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 3（PublicDomainBootstrap 种子 + listOfficialEntries）
- Produces:
```typescript
export class RuleBootstrap {
  constructor(private pubDir: string) {}    // <root>/public-domain/
  resolveRule(ruleId: string): CompiledRule | undefined;
  // 语义：读公域 kind=rule 条目 → parseEbnf 现场编译（失败 → undefined + 记录）→ 内存缓存（Map，失效 = 重建实例）
  ensureInitialized(): void;                // 委托 PublicDomainBootstrap
}
```
- rules.ts 修改：`constructor(dir: string, fallback?: { resolveRule(id: string): CompiledRule | undefined })`——resolveRule 本目录未命中 → fallback?.resolveRule（**写路径不变**：registerRule/updateRule 永远本目录）；既有测试不受影响（无 fallback 时行为不变）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-rule-bootstrap.test.ts`）
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import { RuleRegistry } from "../src/memory/rules.ts";

const FACT_GRAMMAR = "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;";

test("RuleBootstrap resolves seeded rule from public domain", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  const rb = new RuleBootstrap(dir);
  const axiom = rb.resolveRule("axiom");   // 公理条目 resolveRule 语义：kind=axiom 无 EBNF——返回编译产物或 undefined？钉死：axiom 由 RuleRegistry.isAxiom 豁免，bootstrap 层 resolveRule 对 axiom 返回 undefined（不参与校验链）
  const factRule = rb.resolveRule("rule:fact");
  assert.ok(factRule !== undefined);       // 种子 fact 规则可解析
  rmSync(dir, { recursive: true, force: true });
});

test("RuleRegistry fallback chain: private first, then public", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb2-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  const rb = new RuleBootstrap(dir);
  const registry = new RuleRegistry(path.join(dir, "private"), { resolveRule: (id) => rb.resolveRule(id) });
  // 私域无 rule:fact → fallback 命中公域种子
  assert.ok(registry.resolveRule("rule:fact") !== undefined);
  // 私域自建规则优先
  const own = registry.registerRule({ id: "rule:own", kind: "rule", anchors: ["own"], content: "fact = word ;", ruleRef: "axiom" });
  assert.deepEqual(own, []);
  assert.equal(registry.resolveRule("rule:own")!.ruleId, "rule:own");
  rmSync(dir, { recursive: true, force: true });
});
```
> 注：种子规则条目 id 以 PublicDomainBootstrap 实现为准（建议 `rule:fact`/`rule:experience`/`rule:preference` 命名——测试断言与种子实现保持一致；registerRule 签名以 rules.ts 实际为准——参数形态按既有 registerRule(entry) 或测试需要的形状，implementer 按既有用法对齐）

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：rule-bootstrap.ts（RuleBootstrap + 种子 id 约定）；rules.ts 构造器加可选 fallback + resolveRule 回退（现有 rules.ts 测试全绿回归）
- [ ] **Step 4: 全绿** + memory 全套回归
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): RuleRegistry fallback 链 + RuleBootstrap（公域规则只读视图）"`

---

### Task 5: MemoryHost（联合检索/sdk 桥接/方言预检/revive/TTL sweeper）

**Files:**
- Create: `extensions/agent-lab/src/assembly/memory-host.ts`
- Test: `extensions/agent-lab/test/assembly-memory-host.test.ts`

**Interfaces:**
- Consumes: Task 1/3/4 + 记忆系统（MemoryStore/RuleRegistry/MemoryPipeline/WatermarkManager/CommsChannel/DspBuilder/mountMemorySdk）
- Produces:
```typescript
export interface MemoryHostDeps {
  workDir: string;                    // <root>/agents/<agentId>/
  pubDir: string;                     // <root>/public-domain/
  ruleBootstrap: RuleBootstrap;
  spec: MemorySpec;
  now?: () => number;
}
export class MemoryHost {
  readonly store: MemoryStore;        // 私域
  readonly rules: RuleRegistry;       // fallback → RuleBootstrap
  readonly pipeline: MemoryPipeline;
  readonly watermark: WatermarkManager;
  readonly dsp: DspBuilder;           // dir 显式（契约⑧）
  readonly comms?: CommsChannel;
  constructor(deps: MemoryHostDeps);
  retrieve(opts: { anchors?: string[] }): MemoryEntry[];   // 联合：私域（水位过滤 via watermark.visibleVersions）+ 公域 official（listOfficialEntries）并集，去重按 id，私域优先
  attachSdk(sdk: WorkLoopSDK): void;  // mountMemorySdk + 方言预检包装（契约⑤）+ revive 钩子（契约①）
  sweepDrafts(): number;              // TTL sweeper（契约③）：draft && ttlExpiresAt < now → archived；返回清理数
  startSweeper(intervalMs?: number): () => void;  // 返回停止函数（dispose 用）
}
```
- 方言预检包装（⑤）：sdk.memory.write 包装——parseDialect(spec.dialect, entry.content) 失败 → write 结果附加 `warning: "dialect precheck failed: ..."`（不阻止写入——ruleRef EBNF 校验是权威）；markdown 方言 → 强制 status draft（draft-only 语义）
- revive 钩子（①）：write 幂等命中后——pipeline.write 返回既有条目时，若 watermark.isPendingActivation(entry, currentSeq) → watermark.revive(entry.id, nextSeq)（seq 来源 = 注入的 seqProvider: () => number——由 AgentRuntime 提供 runner getter）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-memory-host.test.ts`——核心 3 用例）
```typescript
// 1. 联合检索：私域条目 + 公域种子条目并集、去重、私域优先
// 2. 方言预检：json 方言 content 非 JSON → write 返回 warning；markdown 方言 → 恒 draft
// 3. revive 钩子：pending 条目经幂等命中 → revive 后 visibleVersions 可见（mock seqProvider）
// 4. TTL sweeper：draft 过期 → archived；未过期保留
```
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** memory-host.ts（按 Interfaces；联合检索 = store.retrieve + watermark.visibleVersions(seqProvider()) + pub listOfficialEntries 并集）
- [ ] **Step 4: 全绿**
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): MemoryHost（联合检索/方言预检/revive/TTL sweeper）"`

---

### Task 6: runner 扩展（onCheckpoint 钩子 + payload seq + currentSeq getter + checkpoint latest）

**Files:**
- Modify: `extensions/agent-lab/src/workloop/runner.ts`、`extensions/agent-lab/src/workloop/machine-runtime.ts`、`extensions/agent-lab/src/workloop/checkpoints.ts`
- Test: `extensions/agent-lab/test/runner-hooks.test.ts`

**Interfaces:**
- Produces（契约 ①⑦ 依赖）:
```typescript
// checkpoints.ts
latest(agentId: string): CheckpointRecord | undefined;   // 公开 latest 指针读取（CAS 内部不变）
// machine-runtime.ts
get currentSeq(): number;                                 // 只读当前转移 seq（in-flight；run 外 = 0）
// runner.ts
onCheckpoint(cb: (info: { agentInstanceId: string; checkpointId: string; seq: number }) => void): () => void;  // 返回反注册；按 agentInstanceId 过滤在回调内做
currentSeqOf(agentInstanceId: string): number;            // in-flight 注册表：构造时注册、run 结束注销
// checkpoint.created payload 加 seq: number
```
- **既有行为零变更**：仅新增方法 + payload 增字段（旧消费者按缺省处理）

- [ ] **Step 1: 写失败测试**（新建 `test/runner-hooks.test.ts`——按既有 runner 测试模式 mock 依赖）
```typescript
// 1. onCheckpoint 注册/反注册：run 一轮（mock machine）→ 回调收到 {checkpointId, seq}；反注册后不再收
// 2. currentSeqOf：run 中可读当前 seq（mock 慢转移）；run 结束后 = 0
// 3. checkpoint.latest(agentId) 返回最近 checkpoint
// 4. checkpoint.created payload 含 seq
```
> 注：runner 测试需要 mock 全套依赖（core/registry/stateStore/checkpointStore/eventLog/model/tools/artifacts）——参考既有 `test/workloop-runner.test.ts` 的 fixture 模式；若 fixture 复杂，本任务测试可缩减为"checkpoint.created payload 含 seq + latest() + currentSeq 面"三个最小断言（mock checkpointStore 注入）
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：checkpoints.ts latest()；machine-runtime.ts currentSeq getter（构造时注册到 runner 传入的 seqRegistry？——简化：MachineRuntime 构造器加可选 `onSeq?: (seq: number) => void` 回调（每次 seq 递增调用），runner 持有 Map<agentInstanceId, seq>——**最小侵入：不加 getter 改回调注册**；runner.onCheckpoint 在 checkpoint.created emit 处加钩子分发 + payload 加 seq）
- [ ] **Step 4: 全绿** + workloop/runner 既有测试回归
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): runner/checkpoint 钩子（onCheckpoint/seq 透传/latest 访问器，零行为变更）"`

---

### Task 7: AgentRuntime（run/resume/dispose）

**Files:**
- Create: `extensions/agent-lab/src/assembly/agent-runtime.ts`
- Test: `extensions/agent-lab/test/assembly-agent-runtime.test.ts`

**Interfaces:**
- Consumes: Task 5（MemoryHost）+ Task 6（runner 钩子）+ 既有 WorkLoopRunner
- Produces:
```typescript
export class AgentRuntime {
  readonly agentId: string;
  constructor(deps: {
    agentId: string;
    definition: AgentDefinition;      // 绑定 workloop（自填 workLoopId/version）
    schedulerInstanceId: string;
    runner: WorkLoopRunner;
    memory: MemoryHost;
    ledger: LedgerPort;
    idGen?: () => string;             // 测试注入（默认 randomUUID）
  });
  run(req: { task: string; config?: unknown; optimizationRoundId?: string; signal?: AbortSignal }): Promise<WorkLoopResult>;
  // 自填：traceId/executionId（idGen）/agentInstanceId/workLoopId/workLoopVersion/schedulerInstanceId/optimizationRoundId ?? ""
  resume(checkpointId?: string): Promise<WorkLoopResult>;
  // checkpointId → resumeFromCheckpointId；无参 → runner 侧 latest（task 填恢复 checkpoint 关联任务文本或 ""）
  dispose(): void;                    // memory.startSweeper 停止 + comms 清理
}
```
- run 前序：memory.attachSdk（首次）+ DSP restore 顺序（契约⑦：loadSnapshot(latest seq) → build("restore")——无快照回退 build("realtime")）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-agent-runtime.test.ts`）
```typescript
// 1. run 自填身份字段：mock runner 捕获 request → 断言 agentInstanceId/workLoopId/traceId 非空且绑定 definition
// 2. resume 委托 resumeFromCheckpointId
// 3. dispose 停止 sweeper（mock timer）
// 4. run 前 DSP restore 顺序（mock dsp：先 loadSnapshot 后 build）
```
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** agent-runtime.ts
- [ ] **Step 4: 全绿**
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): AgentRuntime（run 自填绑定/resume/dispose/DSP restore 顺序）"`

---

### Task 8: AgentAssembler（6 步装配流程）

**Files:**
- Create: `extensions/agent-lab/src/assembly/assembler.ts`
- Test: `extensions/agent-lab/test/assembly-assembler.test.ts`

**Interfaces:**
- Consumes: Task 1-7 全部
- Produces:
```typescript
export interface AgentAssemblerDeps {
  registry: DefinitionRegistry;
  agentStore: { getAgent(id: string): AgentInstanceRecord | undefined; insertAgent(r: AgentInstanceRecord): void; };
  ledger: LedgerPort;
  ruleBootstrap: RuleBootstrap;
  runner: WorkLoopRunner;
  workDir: string;                       // <root>
  comms?: { transport: CommsTransport; identity: { agentId: string; tenantId: string; sessionId: string } };
  now?: () => number;
}
export function createAgentAssembler(deps: AgentAssemblerDeps): AgentAssembler;
export interface AgentAssembler { assembleAgent(ref: AgentRef, opts: AssembleOptions): AgentRuntime; }
```
- 装配流程（spec §2.2 六步，顺序钉死）：
```
1. registry.resolve({kind:"workloop", id, version}) → 未注册抛错
2a. config 过 parameterSchema（validateParameters）
2b. agentStore.getAgent(agentId)（agentId = idGen 或 opts 提供？——钉死：agentId 由装配器生成 UUID，供后续复用）——已注册 → 抛错（幂等冲突）
2c. validateMemorySpec(def.memory ?? opts.memory)
3. initialContext/initialState + 记忆域初始化：
   fresh → MemoryHost(workDir/agents/<id>, 空私域 + fallback=ruleBootstrap)
   fork → 拷贝源 agent 私域目录（workDir/agents/<src>/memory/* → 新目录；拷贝后 rebuildIndex + 重建 RuleRegistry）
4. ledger.open(id, K) → {created}；!created → 续跑信号（注册预检已保证未注册——继续）
5. insertAgent(record{ id, schedulerInstanceId, definition, memorySpec, endowment, status:"ready", createdAtRoundId: ROUND_SENTINEL })
6. new AgentRuntime(...) + MemoryHost.attachSdk 延迟到首次 run
失败清理：步骤 3/4/5 任一失败 → 清理记忆域目录（rmSync recursive）+ created===true 时 ledger.removeAccount
```

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-assembler.test.ts`）
```typescript
// 1. 成功装配：mock deps（内存 registry/agentStore/ledger/runner）→ AgentRuntime 返回；insertAgent 调用断言（status ready/哨兵 round）；open created=true
// 2. workloop 未注册 → 抛错
// 3. config 违 schema → 抛错
// 4. 已注册 agent → 抛错（幂等冲突）
// 5. fresh：记忆域空私域 + fallback 解析公域种子规则（ruleBootstrap mock）
// 6. fork：源私域拷贝断言（条目数一致）+ 拷贝后独立演化互不影响
// 7. 失败清理：步骤 5 失败（insertAgent 抛）→ 记忆域目录已删 + removeAccount 被调（created=true 时）
// 8. 续跑：open {created:false}（模拟崩溃残留）→ 装配继续成功（注册预检未注册）
```
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** assembler.ts
- [ ] **Step 4: 全绿**
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): AgentAssembler（6 步装配/fresh-fork 记忆域/续跑幂等/失败清理）"`

---

### Task 9: comms 桥接（transport 适配 + inbox ack + 身份权威）

**Files:**
- Create: `extensions/agent-lab/src/assembly/comms-bridge.ts`
- Test: `extensions/agent-lab/test/assembly-comms-bridge.test.ts`

**Interfaces:**
- Consumes: 记忆系统 CommsChannel/CommsTransport/IdentityMap + Task 7 AgentRuntime
- Produces:
```typescript
export class CommsBridge {
  constructor(deps: { inboxDir: string; channel: CommsChannel; identityMap: IdentityMap; capacity?: number /* 默认 100 */ });
  enqueue(msg: CommsMessage): void;                     // 入 inbox（inbox.jsonl 追加）；溢出 drop-oldest
  drainInto(seq: number): CommsMessage[];               // 取 mergedAtSeq 未定条目 → 并入纸带（委托 AgentRuntime.run 任务文本）→ 标记 mergedAtSeq = seq
  ack(seq: number): void;                               // checkpoint seq ≥ mergedAtSeq → 删除（compact inbox.jsonl）
  pending(): number;
}
// AgentRuntime 集成：run 开始时 drainInto(currentSeq) → 任务文本前缀拼接；resume 时重并入未 ack（按 msgId 去重——CommsChannel.isDuplicate 复用）；run 结束/checkpoint 后 ack
```
- 身份权威（契约⑨）：装配时 IdentityMap.set(agentId, tenantId, sessionId)；session_start 刷新回调（桥接层提供 registerSessionRefresh）

- [ ] **Step 1: 写失败测试**（新建 `test/assembly-comms-bridge.test.ts`）
```typescript
// 1. enqueue/drain/ack 生命周期：消息并入 → ack 后 pending 0
// 2. ack 前 resume 重并入 → 按 msgId 去重（不重复注入）
// 3. 溢出 drop-oldest（容量 2 → 第 3 条丢弃最旧）
// 4. mergedAtSeq 语义：ack(seq) 只删 mergedAtSeq ≤ seq 的条目
```
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** comms-bridge.ts
- [ ] **Step 4: 全绿**
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): comms 桥接（inbox ack/去重/溢出/身份权威）"`

---

### Task 10: 集成冒烟 + bench 演示 + 全量回归

**Files:**
- Create: `extensions/agent-lab/test/assembly-integration.test.ts`、`extensions/agent-lab/bench/assembly-demo.ts`
- Test: `extensions/agent-lab/test/assembly-integration.test.ts`

**Interfaces:**
- Consumes: Task 1-9 全部
- Produces: 端到端冒烟（spec §5 验证标准）

- [ ] **Step 1: 写集成测试**（新建 `test/assembly-integration.test.ts`）
```typescript
// 1. 全链路：createAgentAssembler（真实 SqliteLedger 临时库 + PublicDomainBootstrap 种子 + 内存 runner mock）
//    → assembleAgent（fresh, pi-default-loop 或最小 machine workloop）→ run 一轮 → 断言：
//    AgentInstance 注册 / 开户余额 / 记忆域目录存在（公理 fallback 可解析）/ DSP build 含记忆入口区
// 2. 接线契约抽检（①revive 触发、⑤方言预检警告、⑧dir 无 cwd 污染）
// 3. 零破坏：全量回归 node --experimental-strip-types --test test/*.test.ts（预期 2 pre-existing weighted-scorer 失败）
```
- [ ] **Step 2: 运行确认** → 全绿
- [ ] **Step 3: bench 演示** `bench/assembly-demo.ts`（node --experimental-strip-types bench/assembly-demo.ts）：真实最小装配（json 方言 + endowment 100）+ 一轮 run + 打印装配产物摘要（agentId/余额/记忆域条目数）——演示脚本不做断言
- [ ] **Step 4: 全量回归** + 记忆系统全套（test/memory-*.test.ts）
- [ ] **Step 5: Commit** `git commit -m "feat(assembly): 集成冒烟 + bench 演示（全链路装配/一轮 run/零破坏回归）"`

---

## Self-Review 记录

- **Spec 覆盖**：§2 装配流程（T8）/§2.3 MemorySpec（T1）/§2.4 开户续跑（T2+T8）/§2.5 记忆域模型与规则链（T3+T4+T5）/§3 AgentRuntime（T7）/§3.2 MemoryHost（T5）/§3.3 LedgerPort（T2）/§4 契约 ①-⑩（T5 ①③⑤、T6 ①②⑦ 钩子、T7 ⑦、T9 ⑥⑩、T8 ⑧⑨）/§5 测试策略（T10）/§4.1 类型出处（T1）
- **已知留白（实施中注意）**：T6 runner 测试的 fixture 复杂度（可缩减为最小断言——brief 注明）；T4 种子 id 约定（rule:fact 等——以 PublicDomainBootstrap 实现为准，测试与实现同步）；T8 agentId 生成（装配器生成 UUID——opts 不支持外部指定，幂等冲突靠 getAgent 预检）；pit-communicate 真实传输桥接（T9 是适配器接口 + inbox——真实 mailbox 传输在 D 或后续专项接入，spec §8.3 承认）
- **类型一致性**：AgentRef/MemorySpec/AssembleOptions/ROUND_SENTINEL（T1）→ T4/T5/T8；LedgerPort（T2）→ T8；listOfficialEntries（T3）→ T5；RuleBootstrap.resolveRule（T4）→ T5；MemoryHost（T5）→ T7/T8；runner 钩子（T6）→ T7；AgentRuntime（T7）→ T8/T10；CommsBridge（T9）→ T10。签名跨任务一致
- **依赖序**：T1 →（T2∥T3∥T6）→ T4（T3）→ T5（T1+T3+T4）→ T7（T5+T6）→ T8（T2+T7）→ T9（T7）→ T10（全部）
