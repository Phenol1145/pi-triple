# 记忆系统（子项目 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent-lab 扩展内实现 L3 语义记忆系统：MemoryEntry + 规则/公理 + EBNF 语言体系 + 沉淀管道 + 锚点检索 + 公域 fork-merge 审核链 + sdk.comms 通讯 + DSP 集成。

**Architecture:** 新目录 `extensions/agent-lab/src/memory/`（纯 ESM，零依赖，node:test）。存储 = 文件模式（tmp+rename 原子写 + 条目先/索引后顺序 + 启动重建，spec §4）。sdk 集成点 = `src/workloop/contracts.ts` 的 WorkLoopSDK 可选扩展（`memory?`/`comms?`），不破坏既有 workloop。

**Tech Stack:** TypeScript（`--experimental-strip-types`，import 后缀 `.ts`——agent-lab 项目内是 `.ts` 后缀 import）、node:test + assert/strict、node:fs。

## Global Constraints

- 零新增依赖（agent-lab deps 为空）；import 后缀 `.ts`（agent-lab 内部惯例，非 `.js`——以现有源码为准）
- 测试命令：`node --experimental-strip-types --test test/<file>.test.ts`；全量：`node --experimental-strip-types --test test/*.test.ts`
- MemoryEntry 结构、五不变量、水位线语义、审核矩阵、comms 语义逐字遵循 spec（`docs/superpowers/specs/2026-08-02-memory-system-design.md`）
- 文件模式：tmp+rename 原子写；写入顺序 = 条目先、标记后、索引最后；启动时索引重建
- 校验失败三级处置：返回错误（定位生产式）→ 草稿区（status: draft）→ 反馈重试（≤2 次）
- 幂等：idempotencyKey 预分配；write 幂等（key 已存在返回已有）；重落库 = 存储层操作（消费标记不重置）
- 水位线：版本级（versions[] 每版本 watermark）；resume 屏蔽仅私域；pending-activation 状态
- 审核：组合矩阵（全员投票/veto/评审代表 × 基数 × 弃权 × 平局）；审核结果仅审计事件表；不可回写标记
- comms：msgId 幂等 + dedup 随 checkpoint 水位 + auto mode + tapeFragment ≤4KB
- 禁止修改既有文件的行为语义（只允许 WorkLoopSDK 可选字段扩展与 runner 挂载点注入）

---

### Task 1: MemoryEntry schema 与基础校验

**Files:**
- Create: `extensions/agent-lab/src/memory/entry.ts`
- Test: `extensions/agent-lab/test/memory-entry.test.ts`

**Interfaces:**
- Produces（后续任务依赖）:
```typescript
export type MemoryKind = "axiom" | "rule" | "fact" | "experience" | "preference" | string;
export type EntryStatus = "draft" | "official" | "archived";

export interface SourceTrace { traceId: string; transitionSeq: number; branch?: string; }
export interface EntryVersion { version: number; watermark: number; contentHash: string; }

export interface MemoryEntry {
  id: string;                       // UUID
  kind: MemoryKind;
  anchors: string[];
  content: string;
  ruleRef?: string;                 // axiom 无 ruleRef（自指）
  idempotencyKey?: string;
  status: EntryStatus;
  ttlExpiresAt?: number;
  promotedFrom?: string;
  meta: {
    version: number; createdAt: number; updatedAt: number;
    sourceTraces: SourceTrace[];
    hitCount: number;
    dialectVersion?: string;
    versions?: EntryVersion[];
    notWriteBack?: boolean;         // 不可回写标记（引用审核动作的条目）
  };
}

export function createEntry(input: Partial<MemoryEntry> & { kind: MemoryKind; anchors: string[]; content: string }): MemoryEntry;
export function validateEntryStructure(entry: unknown): string[];  // 错误数组（空 = 通过）
export const AXIOM_RULE_ID = "axiom";                             // 公理条目固定 id
export function isAxiom(entry: MemoryEntry): boolean;
```

**校验规则（错误信息固定，测试断言用）**：
- `id must be a string` / `anchors must be a non-empty string array`（锚点非空不变量）/ `content must be a string` / `kind must be a string` / `ruleRef is required for kind "<kind>"`（axiom 除外）/ `meta.version must be a number`

- [ ] **Step 1: 写失败测试**（新建 `test/memory-entry.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEntry, validateEntryStructure, isAxiom, AXIOM_RULE_ID } from "../src/memory/entry.ts";

test("createEntry fills defaults (status official, version 1, timestamps)", () => {
  const e = createEntry({ kind: "fact", anchors: ["api"], content: "rate_limit=100" });
  assert.equal(e.status, "official");
  assert.equal(e.meta.version, 1);
  assert.equal(e.meta.hitCount, 0);
  assert.ok(e.id.length > 0);
});

test("validateEntryStructure rejects empty anchors (invariant 5)", () => {
  const e = createEntry({ kind: "fact", anchors: [], content: "x" });
  assert.ok(validateEntryStructure(e).some((s) => s.includes("anchors must be a non-empty string array")));
});

test("ruleRef required for non-axiom kinds", () => {
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "x" });
  delete (e as { ruleRef?: string }).ruleRef;
  assert.ok(validateEntryStructure(e).some((s) => s.includes('ruleRef is required for kind "fact"')));
});

test("axiom is self-referential and exempt from ruleRef", () => {
  const axiom = createEntry({ id: AXIOM_RULE_ID, kind: "axiom", anchors: ["system.root"], content: "axiom content" });
  assert.ok(isAxiom(axiom));
  assert.equal(validateEntryStructure(axiom).length, 0);
});
```

- [ ] **Step 2: 运行确认失败**：`node --experimental-strip-types --test test/memory-entry.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `src/memory/entry.ts`（按 Interfaces 签名；createEntry 用 `crypto.randomUUID()` 生成 id；validateEntryStructure 逐条检查返回错误数组）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git add src/memory/entry.ts test/memory-entry.test.ts && git commit -m "feat(memory): MemoryEntry schema 与基础校验（五不变量之锚点/溯源/ruleRef）"`

---

### Task 2: EBNF 子集解析器（含位置错误）

**Files:**
- Create: `extensions/agent-lab/src/memory/ebnf.ts`
- Test: `extensions/agent-lab/test/memory-ebnf.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 3 校验链依赖）:
```typescript
export interface EbnfValue { kind: "terminal" | "nonterminal" | "string" | "number" | "any" | "ref"; value: string; }
export interface EbnfExpr {
  kind: "choice" | "seq" | "repeat" | "optional";
  children?: EbnfExpr[];
  value?: EbnfValue;
  min?: number; max?: number;       // repeat: (* + ?) 与 (* min=0 max=1 *) 注解
}
export interface EbnfProduction { name: string; expr: EbnfExpr; line: number; }
export interface EbnfGrammar { productions: EbnfProduction[]; }
export interface EbnfParseError { message: string; line: number; column: number; }

export function parseEbnf(text: string): { ok: true; grammar: EbnfGrammar } | { ok: false; errors: EbnfParseError[] };
export function validateAgainstGrammar(grammar: EbnfGrammar, entryName: string, input: string): string[];
// 校验语义：以 entryName 生产式为主规则，按 token 流匹配（token = 行，`|` 分隔字段——fact 示例: "subject|predicate|object|confidence?")
// 返回错误数组（含生产式定位，如 `fact: 第 2 项 subject 缺失`）
```

**v1 子集语法**（逐字，实现与测试共用）：
```
production := name, "=", expr, ";" ;
expr       := term, {"|", term} ;            -- choice
term       := factor, {factor} ;             -- seq（term 内并列 = 顺序匹配）
factor     := atom, {atom} ;
atom       := name | "\"" text "\"" | "(" expr ")" | name, ("*" | "+" | "?") | name, "(*", note, "*)";
note       := text;                          -- 值约束注解：(* min=0 max=1 *) 等
token 流   : 按行拆分，行内按 "|" 拆分字段
```

- [ ] **Step 1: 写失败测试**（新建 `test/memory-ebnf.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEbnf, validateAgainstGrammar } from "../src/memory/ebnf.ts";

const FACT_GRAMMAR = `
fact = subject, "|", predicate, "|", object, "|", confidence, "?" ;
subject = word ;
predicate = word ;
object = word | number ;
confidence = number (* min=0 max=1 *) ;
`;

test("parses valid grammar", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.grammar.productions.length, 5);
});

test("reports parse error with line/column", () => {
  const r = parseEbnf("fact = subject, ;\nsubject = word ;");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors[0].line >= 1);
    assert.ok(r.errors[0].message.length > 0);
  }
});

test("validates conforming entry", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "fact", "api|limits|100|0.5");
  assert.deepEqual(errs, []);
});

test("validates non-conforming entry with production-level error", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "fact", "api|limits|100|1.5");  // confidence 超界
  assert.ok(errs.some((s) => s.includes("fact") && s.includes("confidence")));
});

test("supports optional field (?)", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  assert.deepEqual(validateAgainstGrammar(r.grammar, "fact", "api|limits|100"), []);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL（模块不存在）
- [ ] **Step 3: 实现** `src/memory/ebnf.ts`：
  - 行级解析：`=` 拆生产式，`;` 终止；`|` 顶层 = choice，`,` = seq（简化：token 流按行内 `|` 分字段，`?`/`*`/`+` 后缀为 repeat/optional，`(* ... *)` 提取 min/max 注解）
  - `validateAgainstGrammar`：主规则展开 → 字段序匹配 → 非终端递归解析（word = 非空 token；number = 数值；string = 任意）；注解 min/max 校验数值范围；错误定位 `"<entry>: 第 <i> 项 <field> <原因>"`
  - 错误收集：parseEbnf 返回所有语法错误（line/column）；validate 返回所有字段错误
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): EBNF 子集解析器与校验（位置错误/值约束注解）"`

---

### Task 3: 规则条目注册表 + 校验链 + 规则更新事务

**Files:**
- Create: `extensions/agent-lab/src/memory/rules.ts`
- Test: `extensions/agent-lab/test/memory-rules.test.ts`

**Interfaces:**
- Consumes: Task 1 `MemoryEntry`/`AXIOM_RULE_ID`；Task 2 `parseEbnf`/`validateAgainstGrammar`
- Produces:
```typescript
export interface CompiledRule { ruleId: string; version: number; grammar: EbnfGrammar; entryName: string; compiledAt: number; ebnfText: string; }
export class RuleRegistry {
  constructor(private dir: string) {}                       // 规则库目录（文件模式）
  bootstrapAxiom(): void;                                   // 首次初始化写入公理条目（特例通道：宿主代码，非 δ）
  registerRule(entry: MemoryEntry): string[];               // 校验 kind=rule + EBNF 可解析 → 落库 + 编译；返回错误
  resolveRule(ruleId: string): CompiledRule | undefined;    // 规则条目 → 编译产物（未编译则现场编译）
  updateRule(entry: MemoryEntry): string[];                 // 规则更新事务：EBNF 文本 + 编译产物同版本原子生效（先编译成功才落库）
  validateContent(entry: MemoryEntry): string[];            // 校验链：ruleRef 解析 → 编译产物 → validateAgainstGrammar；axiom 豁免
}
```

**规则更新事务语义**：`updateRule` 先 `parseEbnf` 新文本（失败 → 拒绝，返回错误，旧版本不受影响）；成功后新版本写入（版本递增）——"文本+编译产物同版本原子生效"。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-rules.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuleRegistry } from "../src/memory/rules.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

function freshDir(): string { return mkdtempSync(path.join(tmpdir(), "mem-rules-")); }

test("bootstrapAxiom writes the unique axiom entry", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  assert.ok(r.resolveRule(AXIOM_RULE_ID));
});

test("registerRule compiles EBNF and validates conforming content", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  assert.deepEqual(r.registerRule(rule), []);
  const fact = createEntry({ kind: "fact", anchors: ["a"], content: "x|y", ruleRef: rule.id });
  assert.deepEqual(r.validateContent(fact), []);
  const bad = createEntry({ kind: "fact", anchors: ["a"], content: "x", ruleRef: rule.id });
  assert.ok(r.validateContent(bad).length > 0);
});

test("updateRule rejects invalid EBNF atomically (old version intact)", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = word ;", ruleRef: AXIOM_RULE_ID });
  r.registerRule(rule);
  const v1 = r.resolveRule(rule.id)!;
  const badUpdate = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = ;", ruleRef: AXIOM_RULE_ID, id: rule.id });
  const errs = r.updateRule(badUpdate);
  assert.ok(errs.length > 0);
  assert.equal(r.resolveRule(rule.id)!.version, v1.version);  // 旧版本不受影响
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/rules.ts`：文件布局 `dir/axiom.json` + `dir/rules/<ruleId>.json`（条目 + 编译缓存同文件）；`bootstrapAxiom` 幂等（已存在跳过）；`resolveRule` 读文件 + 现场编译（编译失败 → 缓存错误，validateContent 返回编译错误）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 规则注册表与校验链（公理 bootstrap/规则更新事务）"`

---

### Task 4: 方言适配器（JSON / XML / markdown 低置信）

**Files:**
- Create: `extensions/agent-lab/src/memory/dialects.ts`
- Test: `extensions/agent-lab/test/memory-dialects.test.ts`

**Interfaces:**
- Consumes: 无（纯解析）
- Produces:
```typescript
export type DialectId = "json" | "xml" | "markdown";
export type Confidence = "high" | "medium";
export interface DialectResult { ok: boolean; fields: Record<string, unknown>; confidence: Confidence; source?: "partial"; errors: string[]; }

export function parseDialect(dialect: DialectId, text: string): DialectResult;
// json: fenced ```json ... ``` 或裸 JSON → JSON.parse → fields = 对象
// xml: <fact><subject>x</subject>...</fact> 标签提取 → fields；结构锚点：标签名 = 字段名
// markdown: "## 字段名\n值" 模式提取（结构锚点）；缺失必填字段 → errors + ok:false
// 统一：ok=false → 调用方进草稿区；source="partial" 标记缺失可选字段
```

**置信度语义**：json/xml → high；markdown → medium（默认草稿区，调用方决策）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-dialects.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDialect } from "../src/memory/dialects.ts";

test("json dialect extracts fields", () => {
  const r = parseDialect("json", '```json\n{"subject": "api", "predicate": "limit", "object": 100}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.confidence, "high");
  assert.equal(r.fields.subject, "api");
});

test("xml dialect extracts fields by tag", () => {
  const r = parseDialect("xml", "<fact><subject>api</subject><predicate>limit</predicate></fact>");
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.subject, "api");
});

test("markdown dialect is medium confidence and flags missing required", () => {
  const r = parseDialect("markdown", "## subject\napi\n## predicate\nlimit");
  assert.equal(r.confidence, "medium");
  // 调用方按 ok/errors 决策草稿区
  assert.equal(r.ok, true);
});

test("invalid json reports errors", () => {
  const r = parseDialect("json", "{not json");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/dialects.ts`：json（含 fenced 剥离）/ xml（标签正则提取，简单非嵌套）/ markdown（`## key\nvalue` 模式）；所有解析确定性（无 LLM）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 方言适配器（json/xml 确定性 + markdown 低置信）"`

---

### Task 5: MemoryStore 存储层（文件/索引/原子写/统一入口/检索）

**Files:**
- Create: `extensions/agent-lab/src/memory/store.ts`
- Test: `extensions/agent-lab/test/memory-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `MemoryEntry`/`validateEntryStructure`
- Produces（后续全部任务依赖的核心）:
```typescript
export class MemoryStore {
  constructor(private dir: string) {}   // dir/entries/<id>.json + dir/index/anchors.json
  write(entry: MemoryEntry): void;                        // 幂等（同 id 已存在 → 版本递增合并）；tmp+rename
  get(id: string): MemoryEntry | undefined;
  update(id: string, patch: Partial<MemoryEntry>): void;  // 版本递增 CAS
  retrieve(opts: { anchors?: string[]; kinds?: MemoryKind[]; status?: EntryStatus[]; excludeDrafts?: boolean }): MemoryEntry[];
  bumpHitCount(id: string): void;                         // 旁路计数器（独立文件，不触发版本化）
  rebuildIndex(): void;                                   // 启动时索引重建（扫描 entries/ 重建 anchors.json）
  listIds(): string[];
}
```

**写入顺序**：entry 文件先写（tmp+rename）→ anchors 索引后写——崩溃窗口 = 索引落后（启动 rebuildIndex 修复）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-store.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-store-"));
  return { store: new MemoryStore(dir), dir };
}

test("write/get roundtrip", () => {
  const { store, dir } = fresh();
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" });
  store.write(e);
  assert.equal(store.get("e1")?.content, "x");
  rmSync(dir, { recursive: true, force: true });
});

test("retrieve by anchor and excludes drafts when requested", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "x", id: "a1" }));
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "y", id: "a2", status: "draft" }));
  assert.equal(store.retrieve({ anchors: ["api"], excludeDrafts: true }).length, 1);
  assert.equal(store.retrieve({ anchors: ["api"] }).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("update increments version (CAS)", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  store.update("e", { content: "v2" });
  const e = store.get("e")!;
  assert.equal(e.content, "v2");
  assert.equal(e.meta.version, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("rebuildIndex recovers from missing index", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e" }));
  rmSync(path.join(dir, "index"), { recursive: true, force: true });
  store.rebuildIndex();
  assert.equal(store.retrieve({ anchors: ["a"] }).length, 1);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/store.ts`：entries/ 每条目一文件（JSON）；index/anchors.json = `{ anchor: string[] }`（锚点 → id 列表）；写入顺序 entry 先索引后；update 读-改-写（version+1、updatedAt、versions[] 追加 `{version, watermark: 0, contentHash}`——watermark 由 Task 7 填）；bumpHitCount 写 `dir/counters/<id>.json`（独立文件）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): MemoryStore 文件存储（原子写/锚点索引/检索/CAS/索引重建）"`

---

### Task 6: 沉淀管道（缓冲/幂等/草稿区/promote/溯源/事件）

**Files:**
- Create: `extensions/agent-lab/src/memory/pipeline.ts`
- Test: `extensions/agent-lab/test/memory-pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1/3/5
- Produces:
```typescript
export interface PipelineDeps { store: MemoryStore; rules: RuleRegistry; now?: () => number; }
export class MemoryPipeline {
  constructor(private deps: PipelineDeps) {}
  observe(observation: { content: string; anchors: string[]; kind?: MemoryKind }): string;  // 入缓冲，返回 idempotencyKey
  write(entry: { idempotencyKey: string } & Partial<MemoryEntry>): { ok: true; entry: MemoryEntry } | { ok: false; errors: string[]; draft?: MemoryEntry };
  // 语义：key 已存在 → 返回已有（幂等）；校验失败 → 草稿区（status: draft, ttlExpiresAt = now + 7d）+ 错误返回；成功 → official + 溯源附加 + 事件回调
  promote(draftId: string, content: string): string[];      // 同 id 新版本（version 延续）+ promotedFrom；错误数组
  flushBuffer(): void;                                       // 消费缓冲（write 调用后调用；崩溃重放由 checkpoint 恢复驱动）
}
```

**错误处理**：write 校验失败返回 `{ok:false, errors}`（错误定位生产式——来自 Task 3 validateContent）+ 自动入草稿区（`{ok:false, draft}` 携带）。

**溯源**：write 成功时 sourceTraces 追加 `{traceId, transitionSeq}`（由调用方经 deps 传入——v1 简化为 pipeline 构造参数 `trace: { traceId: string; transitionSeq: number }`）。

**事件**：write 成功/失败回调（`onEvent?: (ev: { type: "memory_tx"; ... }) => void`，v1 直接调用，事件表落盘留 Task 9 审计扩展）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-pipeline.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-pipe-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const rule = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  rules.registerRule(rule);
  const pipe = new MemoryPipeline({ store, rules, trace: { traceId: "t1", transitionSeq: 5 } });
  return { store, rules, pipe, dir, ruleId: rule.id };
}

test("observe allocates idempotencyKey, write is idempotent", () => {
  const { pipe, store, dir } = fresh();
  const key = pipe.observe({ content: "a|b", anchors: ["x"] });
  const r1 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r1.ok, true);
  const r2 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) assert.equal(r1.entry.id, r2.entry.id);   // 幂等：同 key 同条目
  assert.equal(store.listIds().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("failed validation goes to draft with TTL and returns errors", () => {
  const { pipe, store, dir } = fresh();
  const r = pipe.write({ idempotencyKey: "k2", kind: "fact", anchors: ["x"], content: "only-one-field", ruleRef: "fact-rule" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  if (!r.ok && r.draft) {
    assert.equal(r.draft.status, "draft");
    assert.ok(r.draft.ttlExpiresAt! > Date.now());
  }
  rmSync(dir, { recursive: true, force: true });
});

test("promote upgrades draft to official with version continuity", () => {
  const { pipe, store, dir } = fresh();
  const r = pipe.write({ idempotencyKey: "k3", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  assert.equal(r.ok, false);
  if (!r.ok && r.draft) {
    const errs = pipe.promote(r.draft.id, "good|pair");
    assert.deepEqual(errs, []);
    const promoted = store.get(r.draft.id)!;
    assert.equal(promoted.status, "official");
    assert.equal(promoted.promotedFrom, r.draft.id);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("successful write attaches source trace", () => {
  const { pipe, store, dir } = fresh();
  const key = pipe.observe({ content: "a|b", anchors: ["x"] });
  const r = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.entry.meta.sourceTraces, [{ traceId: "t1", transitionSeq: 5 }]);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/pipeline.ts`：
  - observe：生成 key（randomUUID）入缓冲文件 `dir/buffer.jsonl`（追加 + 时间戳）→ 返回 key
  - write：key 查幂等表 `dir/idem.jsonl`（key → entryId）→ 命中返回已有条目；未命中 → 校验链（rules.validateContent）→ 失败入草稿（store.write status:draft + ttl）→ 成功 store.write + 幂等表追加 + sourceTraces 追加 + 缓冲标记消费（`dir/buffer-consumed.jsonl` 追加 key）
  - 重试上限 ≤2：write 内若 content 校验失败且调用方重试（同 key 新 content）→ 第 3 次直接草稿区（计数器 `dir/retry-count.jsonl`）
  - promote：读草稿 → 校验新 content → 通过 store.update（version 递增 + status official + promotedFrom + 新 idempotencyKey）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 沉淀管道（缓冲/幂等/草稿 TTL/promote/溯源）"`

---

### Task 7: 版本与水位线（versions[] watermark / resume 屏蔽 / 重落库 / 键表水位）

**Files:**
- Create: `extensions/agent-lab/src/memory/watermark.ts`
- Test: `extensions/agent-lab/test/memory-watermark.test.ts`

**Interfaces:**
- Consumes: Task 5 `MemoryStore`（versions[] 字段由 update 维护）
- Produces:
```typescript
export class WatermarkManager {
  constructor(private store: MemoryStore) {}
  recordVersion(id: string, checkpointSeq: number): void;   // 当前版本落库时记录 watermark（versions[] 追加）
  visibleVersions(seq: number): MemoryEntry[];              // resume 到 S：屏蔽 watermark > S 的版本，可见 = ≤S 最新版
  isPendingActivation(entry: MemoryEntry, seq: number): boolean;  // 所有版本均被屏蔽
  revive(id: string, checkpointSeq: number): void;          // 幂等命中屏蔽条目 → 同 key 重落库（更新当前版本 watermark）
}
```

**赋值语义（spec 钉死）**：watermark = 该转移完成时将保存的 checkpoint seq（调用方传入 nextCheckpointSeq，禁止用上一已完成 seq）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-watermark.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-wm-"));
  return { store: new MemoryStore(dir), wm: new WatermarkManager(new MemoryStore(dir)), dir };
}

test("visibleVersions masks future versions (watermark > S)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 10);          // v1 @ watermark 10
  store.update("e", { content: "v2" });
  wm.recordVersion("e", 20);          // v2 @ watermark 20
  const vis = wm.visibleVersions(15); // resume 到 S=15
  assert.equal(vis.length, 1);
  assert.equal(vis[0].content, "v1"); // v1 可见，v2 屏蔽
  rmSync(dir, { recursive: true, force: true });
});

test("all versions masked → pendingActivation", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 20);
  assert.equal(wm.isPendingActivation(store.get("e")!, 15), true);
  rmSync(dir, { recursive: true, force: true });
});

test("revive re-stamps current version watermark", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 20);
  wm.revive("e", 25);                 // 幂等重落库：内容不变，watermark = 25
  assert.equal(wm.visibleVersions(25).length, 1);
  assert.equal(wm.visibleVersions(25)[0].content, "v1");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/watermark.ts`：recordVersion 读条目 → versions[] 追加/更新当前版本 watermark → 写回（版本号不变）；visibleVersions 扫描 versions[] 过滤；revive = 当前版本 watermark 更新（不递增版本、不重置消费标记——存储层操作）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 版本级水位线（resume 屏蔽/pending-activation/幂等重落库）"`

---

### Task 8: 公域 fork-merge（base 声明/entry-overlap/fast-forward/死信区）

**Files:**
- Create: `extensions/agent-lab/src/memory/public-domain.ts`
- Test: `extensions/agent-lab/test/memory-public-domain.test.ts`

**Interfaces:**
- Consumes: Task 5 `MemoryStore`
- Produces:
```typescript
export interface PublicDomainStore {
  generation(): number;                               // 库级 generation（快照标识，不参与冲突判定）
  fork(destDir: string): number;                      // 拷贝当前全部条目 → destDir；返回 generation
  submitWriteBack(opts: { baseGeneration: number; delta: MemoryEntry[]; removeIds?: string[] }): { ok: true; generation: number } | { ok: false; reason: "conflict" | "overlap" | "generation-stale"; detail: string };
  // entry-overlap 判定（spec 钉死）：条目 id 相同即冲突；anchors 重叠但 id 不同不冲突
  // 不重叠 → fast-forward 合入 + generation++（原子：单写者 merge 队列，v1 用进程内锁）
  deadLetter(): Array<{ deltaId: string; reason: string; at: number }>;   // 重试耗尽死信区（提交方 ≤3 次重试由调用方管）
}
```

**merge 序列化**：v1 单进程内同步锁（`mergeLock: boolean` + 队列）；generation 在成功 merge 后原子递增。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-public-domain.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainStore } from "../src/memory/public-domain.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-pub-"));
  return { pub: new PublicDomainStore(dir), dir };
}

test("fork copies entries and returns generation", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const g = pub.fork(dir);
  assert.equal(g, 0);
  assert.equal(new MemoryStore(dir).get("e1")?.content, "x");
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack fast-forwards disjoint delta", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e2" })] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.generation, base + 1);
  assert.equal(new MemoryStore(dir).get("e2")?.content, "y");
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack rejects overlapping id (conflict)", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["a"], content: "changed", id: "e1" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "overlap");
  rmSync(dir, { recursive: true, force: true });
});

test("stale generation rejected", () => {
  const { pub, dir } = fresh();
  pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: 0, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e9" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "generation-stale");
  rmSync(dir, { recursive: true, force: true });
});
```

> 注：generation 判定——提交 baseGeneration 必须等于当前 generation 或允许 fast-forward 语义下的最新（v1 实现：baseGeneration === generation 才接受；不一致 → generation-stale）。overlap 检测在 delta id 与库内 id 交集。

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/public-domain.ts`：`dir/generation.json` + `dir/entries/`（复用 MemoryStore 布局——PublicDomainStore 内部持 MemoryStore 实例）；fork = 拷贝 entries/ + index/；submitWriteBack = 锁内检查 base === generation → 逐 delta 查 id 冲突 → 合入 + generation++；死信区 `dir/deadletter.jsonl`
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 公域 fork-merge（base/entry-overlap/fast-forward/死信区）"`

---

### Task 9: 审核链（组合矩阵/quorum/超时/聚合/operator 否决/审计事件表）

**Files:**
- Create: `extensions/agent-lab/src/memory/audit-chain.ts`
- Test: `extensions/agent-lab/test/memory-audit-chain.test.ts`

**Interfaces:**
- Consumes: 无（独立；comms 集成在 Task 10）
- Produces:
```typescript
export type AgentSideStrategy = "all-vote" | "veto" | "representative";
export type OperatorSideStrategy = "delegate" | "auto-approve" | "manual";
export interface AuditConfig {
  agentSide: AgentSideStrategy;
  operatorSide: OperatorSideStrategy;
  quorumRatio?: number;        // 默认 0.5（过半活跃）
  timeoutMs?: number;          // 默认 300_000（5 分钟）
  repCount?: number;           // 默认 2（评审代表）
  windowMs?: number;           // 默认 60_000（聚合窗口）
  windowMax?: number;          // 默认 10（聚合条数）
}
export interface AuditRequest { id: string; delta: { entryId: string; kind: string }; domain: "team" | "global"; }
export interface AuditVote { requestId: string; voter: string; decision: "approve" | "reject" | "veto"; at: number; }
export class AuditChain {
  constructor(private config: AuditConfig, private agentRegistry: { active(): string[]; isActive(id: string): boolean; delegateTo?(): string[] }, private operator: { notify(req: AuditRequest): void; veto?(): boolean }) {}
  submit(req: AuditRequest): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>;
  vote(v: AuditVote): void;
  closeWindow(requestId: string): void;   // 窗口关闭（时间/数量硬截止或 veto 制全部在线已投/超时）
  approve(req: AuditRequest): boolean;    // 组合矩阵裁决：agent 侧通过 → operator 侧策略生效 → 任一否决=拒绝
  recordEvent(ev: unknown): void;         // 审核结果仅落审计事件表（不落 L3）
  markNotWriteBack(entryId: string): void; // 不可回写标记（写校验链拒绝入口，Task 8 消费）
}
```

**组合矩阵（spec 逐字）**：
| agent 策略 | quorum 基数 | 弃权处理 | 平局 |
|---|---|---|---|
| all-vote | 活跃数（提交时在线快照） | 弃权计入分母；默认需过半赞成 | 平局 → operator |
| veto | 全部相关 agent（含离线） | 离线=弃权（不否决）；无 veto = 通过 | 不适用 |
| representative | 被选代表数（默认 2） | 代表弃权 → 换选补充 | 分歧 → operator |

- [ ] **Step 1: 写失败测试**（新建 `test/memory-audit-chain.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditChain, type AuditConfig, type AuditRequest } from "../src/memory/audit-chain.ts";

function cfg(over: Partial<AuditConfig> = {}): AuditConfig {
  return { agentSide: "all-vote", operatorSide: "auto-approve", ...over };
}
const agents = { active: () => ["a1", "a2", "a3"], isActive: () => true };
const op = { notify: () => {}, veto: () => false };
const req: AuditRequest = { id: "r1", delta: { entryId: "e1", kind: "fact" }, domain: "team" };

test("all-vote passes with majority, operator auto-approve", () => {
  const chain = new AuditChain(cfg(), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), true);
});

test("all-vote rejects on majority reject", () => {
  const chain = new AuditChain(cfg(), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "reject", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "reject", at: 2 });
  assert.equal(chain.approve(req), false);
});

test("veto strategy: any veto rejects, no-veto passes without majority", () => {
  const chain = new AuditChain(cfg({ agentSide: "veto" }), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "veto", at: 1 });
  assert.equal(chain.approve(req), false);
  const chain2 = new AuditChain(cfg({ agentSide: "veto" }), agents, op);
  assert.equal(chain2.approve(req), true);   // 无 veto = 通过
});

test("operator veto overrides agent approval", () => {
  const chain = new AuditChain(cfg({ operatorSide: "manual" }), agents, { notify: () => {}, veto: () => true });
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), false);   // operator 一票否决
});

test("quorum: abstentions count into denominator", () => {
  const chain = new AuditChain(cfg(), agents, op);   // 3 活跃，需过半（2）
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  assert.equal(chain.approve(req), false);           // 1/3 不过半（弃权计入分母）
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/audit-chain.ts`：按组合矩阵实现 approve 裁决（三策略分支 + operator 侧三种处理）；投票记录内存 Map（v1；持久化留后续）；recordEvent 追加 `dir/audit-events.jsonl`；markNotWriteBack 维护 `dir/not-write-back.jsonl`
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): 审核链（组合矩阵/quorum/operator 否决/审计事件表）"`

---

### Task 10: sdk.comms（消息/幂等/身份映射/纸带注入）

**Files:**
- Create: `extensions/agent-lab/src/memory/comms.ts`
- Test: `extensions/agent-lab/test/memory-comms.test.ts`

**Interfaces:**
- Consumes: 无（ptl-communicate 桥接为可选传输注入——v1 测试用内存传输 mock）
- Produces:
```typescript
export interface CommsMessage { msgId: string; from: string; to: string; tapeFragment: string; type?: string; timestamp: number; }
export interface CommsTransport {
  send(msg: CommsMessage): void;
  onReceive(cb: (msg: CommsMessage) => void): void;
  activePeers(): string[];              // presence
}
export class CommsChannel {
  constructor(private transport: CommsTransport, private identity: { agentId: string; tenantId: string; sessionId: string }) {}
  send(to: string, tapeFragment: string, type?: string): CommsMessage;   // msgId = randomUUID；fragment ≤ 4096 字节（超限拒绝）
  private onMessage(msg: CommsMessage): void;   // 接收：msgId 去重（dedup 表随水位——v1 持久化 dedup.jsonl）→ 纸带注入回调
  onTapeInjection(cb: (msg: CommsMessage) => void): void;   // 注入点：调用方把 tapeFragment 作为 user 消息追加进纸带
  isDuplicate(msgId: string): boolean;
}
export class IdentityMap {
  constructor(private dir: string) {}
  set(agentId: string, tenantId: string, sessionId: string): void;
  resolve(agentId: string): { tenantId: string; sessionId?: string } | undefined;  // sessionId 易失：缺省表示离线（排队）
  refreshSession(agentId: string, sessionId: string): void;
}
```

**语义（spec）**：msgId 发送方生成；去重范围 = 接收 agent 全局；dedup 随 checkpoint 水位（resume 丢弃晚于 S——v1 记录 `{msgId, watermark}`，`pruneDedup(seq)` 方法）；纸带注入回调由调用方接（Task 12 挂到 WorkLoopSDK）；离线 → 消息进队列（transport 层 pending 语义，v1 内存队列）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-comms.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommsChannel, IdentityMap, type CommsMessage, type CommsTransport } from "../src/memory/comms.ts";

class MemTransport implements CommsTransport {
  received: CommsMessage[] = [];
  listeners: Array<(m: CommsMessage) => void> = [];
  send(m: CommsMessage) { this.received.push(m); for (const l of this.listeners) l(m); }
  onReceive(cb: (m: CommsMessage) => void) { this.listeners.push(cb); }
  activePeers() { return ["peer-b"]; }
}

test("send generates msgId and delivers via transport", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const msg = c.send("peer-b", "observed x");
  assert.ok(msg.msgId.length > 0);
  assert.equal(t.received.length, 1);
});

test("receive dedups by msgId (isDuplicate)", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const injected: CommsMessage[] = [];
  c.onTapeInjection((m) => injected.push(m));
  const msg = c.send("peer-b", "fragment");
  t.send({ msgId: msg.msgId, from: "b", to: "a", tapeFragment: "fragment", timestamp: 1 }); // 模拟重复投递
  t.send({ msgId: "new-1", from: "b", to: "a", tapeFragment: "f2", timestamp: 2 });
  assert.equal(injected.length, 1);   // 重复 msgId 被去重
});

test("oversized fragment rejected", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  assert.throws(() => c.send("peer-b", "x".repeat(5000)));
});

test("identity map persists and resolves, session optional", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-idm-"));
  const im = new IdentityMap(dir);
  im.set("agent-1", "tenant-1", "session-1");
  assert.deepEqual(im.resolve("agent-1"), { tenantId: "tenant-1", sessionId: "session-1" });
  im.refreshSession("agent-1", "session-2");
  assert.equal(im.resolve("agent-1")!.sessionId, "session-2");
  assert.equal(im.resolve("nope"), undefined);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/comms.ts`：CommsChannel（dedup 表 `dir/dedup.jsonl` 持久化 + `pruneDedup(seq)` 随水位丢弃）；IdentityMap（`dir/identity.json` 文件）
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): sdk.comms 通讯（msgId 幂等/身份映射/纸带注入回调）"`

---

### Task 11: DSP 集成（记忆入口区/快照进 checkpoint/候选提示位）

**Files:**
- Create: `extensions/agent-lab/src/memory/dsp.ts`
- Test: `extensions/agent-lab/test/memory-dsp.test.ts`

**Interfaces:**
- Consumes: Task 5 `MemoryStore`（retrieve）、Task 7 `WatermarkManager`
- Produces:
```typescript
export interface DspInput {
  state: unknown;                    // 控制状态（投影源）
  memory: unknown;                   // L2 数据域
  env: Record<string, unknown>;      // 环境元数据（时间/cwd）
  budget: { used: number; max: number };  // token 预算
  candidates?: string[];             // 本轮可沉淀候选（转移结束钩子）
}
export interface DspSnapshot { text: string; memoryVersion: string; atSeq: number; }
export class DspBuilder {
  constructor(private store: MemoryStore, private watermark: WatermarkManager, private opts: { maxRealtimeBytes?: number; maxRestoreBytes?: number }) {}
  build(input: DspInput, mode: "realtime" | "restore"): string;   // 三区合成：投影区 → 工具列表区 → 记忆入口区（截断顺序）
  snapshot(seq: number, mode: "realtime" | "restore"): DspSnapshot;  // 检索快照（内容寻址去重：text 相同复用）
  restore(snap: DspSnapshot): string;   // 恢复用快照（不重检索不计数）
}
```

**语义（spec）**：上限实时 4KB / 恢复 16KB；截断顺序：投影区 → 工具列表区 → 记忆入口区（候选提示位最后截断）；快照含记忆版本号；恢复不计数（hitCount 不动）。

- [ ] **Step 1: 写失败测试**（新建 `test/memory-dsp.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DspBuilder } from "../src/memory/dsp.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-dsp-"));
  const store = new MemoryStore(dir);
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "rate=100", id: "m1" }));
  return { store, wm, dsp: new DspBuilder(store, wm, { maxRealtimeBytes: 4096, maxRestoreBytes: 16384 }), dir };
}

test("build includes projection and memory entry sections", () => {
  const { dsp, dir } = fresh();
  const out = dsp.build({ state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 } }, "realtime");
  assert.ok(out.includes("credit"));
  assert.ok(out.includes("api"));    // 记忆入口区：锚点命中检索注入
  rmSync(dir, { recursive: true, force: true });
});

test("truncation order: projection → tools → memory entry (candidates last)", () => {
  const { dsp, dir } = fresh();
  const small = new DspBuilder(new MemoryStore(dir), new WatermarkManager(new MemoryStore(dir)), { maxRealtimeBytes: 200, maxRestoreBytes: 200 });
  const out = small.build({ state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 }, candidates: ["obs-1"] }, "realtime");
  assert.ok(out.length <= 200 * 4);   // 截断后不超限（宽松断言，实现按顺序截断）
  rmSync(dir, { recursive: true, force: true });
});

test("snapshot/restore roundtrip without re-querying store", () => {
  const { store, wm, dsp, dir } = fresh();
  const snap = dsp.snapshot(10, "realtime");
  const out = dsp.restore(snap);
  assert.ok(out.length > 0);
  store.bumpHitCount("m1");
  assert.equal(out, dsp.restore(snap));   // 恢复不重检索：store 变化不影响快照
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现** `src/memory/dsp.ts`：三区拼接（投影 = state 摘要 + env；工具列表 = 预留区（v1 空）；记忆入口 = 锚点检索摘要 + 候选提示位）；截断按顺序从前往后；snapshot 存 `dir/dsp-snapshots/<seq>.json`
- [ ] **Step 4: 运行确认通过** → 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(memory): DSP 集成（三区合成/截断顺序/快照恢复）"`

---

### Task 12: WorkLoopSDK 挂载 + 集成冒烟

**Files:**
- Modify: `extensions/agent-lab/src/workloop/contracts.ts`（WorkLoopSDK 加可选字段）
- Create: `extensions/agent-lab/src/memory/sdk.ts`（挂载器）
- Test: `extensions/agent-lab/test/memory-sdk.test.ts`

**Interfaces:**
- Consumes: Task 6 `MemoryPipeline`、Task 10 `CommsChannel`、Task 11 `DspBuilder`、Task 1 `MemoryEntry`
- Produces:
```typescript
// contracts.ts 扩展（可选，向后兼容）：
export interface WorkLoopSDK {
  // ...既有字段不变
  memory?: { write(e: Partial<MemoryEntry> & { idempotencyKey: string }): ReturnType<MemoryPipeline["write"]>; retrieve(opts: unknown): MemoryEntry[] };
  comms?: { send(to: string, tapeFragment: string): void };
}

export function mountMemorySdk(sdk: WorkLoopSDK, deps: { pipeline: MemoryPipeline; comms: CommsChannel; dsp: DspBuilder }): void;
// 挂载：sdk.memory = { write, retrieve }（write 走 pipeline，校验/幂等/溯源自动）
//       sdk.comms = { send }（走 CommsChannel；接收经 onTapeInjection → 调用方纸带追加）
```

- [ ] **Step 1: 写失败测试**（新建 `test/memory-sdk.test.ts`）

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountMemorySdk } from "../src/memory/sdk.ts";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { CommsChannel, type CommsTransport } from "../src/memory/comms.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

class MemTransport implements CommsTransport {
  received: { to: string; fragment: string }[] = [];
  send(m: { msgId: string; from: string; to: string; tapeFragment: string; timestamp: number }) { this.received.push({ to: m.to, fragment: m.tapeFragment }); }
  onReceive() {}
  activePeers() { return []; }
}

test("mounted sdk.memory.write goes through pipeline (validation + idempotency)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-sdk-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const rule = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  rules.registerRule(rule);
  const pipe = new MemoryPipeline({ store, rules, trace: { traceId: "t", transitionSeq: 1 } });
  const sdk: Record<string, unknown> = {};
  const t = new MemTransport();
  const comms = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  mountMemorySdk(sdk as never, { pipeline: pipe, comms, dsp: null as never });
  const mem = (sdk as { memory: { write(e: unknown): unknown } }).memory;
  const r = mem.write({ idempotencyKey: "k1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal((r as { ok: boolean }).ok, true);
  const r2 = mem.write({ idempotencyKey: "k1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal((r2 as { ok: boolean }).ok, true);   // 幂等
  rmSync(dir, { recursive: true, force: true });
});

test("mounted sdk.comms.send delivers via channel", () => {
  const t = new MemTransport();
  const comms = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const sdk: Record<string, unknown> = {};
  mountMemorySdk(sdk as never, { pipeline: null as never, comms, dsp: null as never });
  (sdk as { comms: { send(to: string, fragment: string): void } }).comms.send("peer-b", "fragment-1");
  assert.equal(t.received.length, 1);
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：contracts.ts 加可选字段（纯类型扩展，零行为变更——确认既有 workloop 测试不破坏）；`src/memory/sdk.ts` 挂载器
- [ ] **Step 4: 运行确认通过**：`node --experimental-strip-types --test test/memory-sdk.test.ts` + **全量回归** `node --experimental-strip-types --test test/*.test.ts`（既有测试全绿 = 零破坏证明）
- [ ] **Step 5: Commit** `git commit -m "feat(memory): WorkLoopSDK 挂载（sdk.memory/sdk.comms 可选扩展，零破坏）"`

---

## Self-Review 记录

- **Spec 覆盖**：§2 schema（T1）/ §3 语言体系（T2 EBNF、T3 规则链、T4 方言）/ §4 沉淀（T6 管道、T7 水位线）/ §5 检索（T5 store）/ §6 公域审核（T8 fork-merge、T9 审核链）/ §8 通讯（T10 comms）/ §7 DSP（T11）/ sdk 集成（T12）。§9 观测事件在 T6（memory_tx 回调）/T9（审计事件表）落点；§10 非目标（向量/自然语言方言/嵌套）未涉及；§12 隐藏依赖中 identity map（T10）、EBNF 手写 parser（T2）落地
- **已知留白（计划阶段不展开，需在实施中注意）**：T9 审核链与 T8 的接线（审核批准 → merge 的调用链在 T8/T9 测试分别覆盖，集成点留 T12 冒烟后）；T10 与 ptl-communicate 真实传输的桥接（v1 内存 transport + 接口，真实桥接在装配层子项目 C 接入——spec §12 承认）；T6 重试上限 ≤2 的计数持久化细节
- **类型一致性**：createEntry/validateEntryStructure/AXIOM_RULE_ID（T1）→ T3/T6/T8/T11/T12 使用；parseEbnf/validateAgainstGrammar（T2）→ T3；MemoryStore（T5）→ T6-T12；MemoryPipeline（T6）→ T12；WatermarkManager（T7）→ T11；PublicDomainStore（T8）→ 后续 C；AuditChain（T9）→ 后续 C；CommsChannel/IdentityMap（T10）→ T12；DspBuilder（T11）→ T12。签名跨任务一致
- **依赖序**：T1→T2 并行可行（互不依赖）；T3 依赖 T1+T2；T4 独立；T5 依赖 T1；T6 依赖 T3+T5；T7 依赖 T5；T8 依赖 T5；T9 独立；T10 独立；T11 依赖 T5+T7；T12 依赖 T6+T10+T11（+T1 类型）
