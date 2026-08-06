# 信息摄入循环 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地联邦第一里程碑——仓库 docs 零拷贝摄入 → 路径推导标签 → 指针条目入记忆系统 → 周期流自动派发语义分解任务，全程机械/智能分工（摄入不经 agent）。

**Architecture:** 新目录 `extensions/agent-lab/src/ingest/`（纯增量，零依赖，node:test）。摄入管道 = 源适配器（v1 仓库 docs）+ 标签推导 + 指针条目写入（走既有 MemoryPipeline 获得校验/幂等/溯源/事件）。周期流 = 模块自带定时器（spec §5 实现选择 b，机械行为不进 agent 路径），产出增量后为变更文档派发"语义分解"任务（labels.strategy="weighted" 经策略解析器路由）。

**Tech Stack:** TypeScript（`--experimental-strip-types`，import 后缀 `.ts`）、node:test + assert/strict、node:crypto/fs。零新增依赖。

## Global Constraints

- 零新增依赖；import 后缀 `.ts`（agent-lab 内部惯例）
- 测试命令：`cd extensions/agent-lab && node --experimental-strip-types --test test/<file>.test.ts`；全量 `npm test`（weighted-scorer-bootstrap 2 个**既有**失败忽略）
- 不修改任何既有文件的行为语义（本计划全部为新建文件；不改 memory/、scheduler/ 既有源码）
- 记忆系统不变量逐字遵守：锚点非空、ruleRef 必须指向已注册规则、幂等走 MemoryPipeline.write
- 指针条目内容格式：`# <title>\n\n<firstPara>\n\n源: <relPath>`；title/firstPara 中的 `|` 字符替换为 `／`（EBNF 校验按行内 `|` 分字段，必须规避）
- EBNF 校验语义：内容按行拆 token（空行跳过），每行按 `|` 拆字段，对主生产式匹配；`word` 内置 = 任意非空字段
- 提交风格 `feat(agent-lab): 中文摘要——细节`，直接 main；不碰并行 WIP（Dockerfile.dev、tools/dev/bfc/ 等）
- 全计划完成后回归：agent-lab `npm test` + 根仓库 `npx vitest run` + `npm run lint`

## 关键接口参考（既有代码，本计划不改）

```typescript
// memory/pipeline.ts
MemoryPipeline.write(entry: { idempotencyKey: string } & Partial<MemoryEntry>):
  { ok: true; entry: MemoryEntry } | { ok: false; errors: string[]; draft?: MemoryEntry }
// 幂等：key 已存在 → 返回已有条目；校验失败 → 草稿区 + errors

// memory/entry.ts
createEntry(input: Partial<MemoryEntry> & { kind; anchors; content }): MemoryEntry
// input.id 有值则保留（指针条目确定性 id 依赖此行为）
AXIOM_RULE_ID  // 公理规则 id（注册新规则时 ruleRef 指向它）

// memory/store.ts
new MemoryStore(dir); store.get(id); store.write(entry)  // 已有 id → version 自动 +1
store.retrieve({ anchors?, kinds?, status?, excludeDrafts? }): MemoryEntry[]
store.bumpHitCount(id)  // 旁路热度计数（不版本化）

// memory/rules.ts
new RuleRegistry(dir); rules.bootstrapAxiom(); rules.registerRule(entry): string[]
rules.resolveRule(ruleId): CompiledRule | undefined

// scheduler/runner-types.ts
DispatchRequest { traceId, role, task, taskCategory?, labels?, caller?, mode?, strategy?, agentId?, ... }
```

测试构造范式（照抄 test/memory-pipeline.test.ts）：

```typescript
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
const dir = mkdtempSync(path.join(tmpdir(), "ingest-"));
const store = new MemoryStore(dir);
const rules = new RuleRegistry(dir);
rules.bootstrapAxiom();
const pipe = new MemoryPipeline({ dir, store, rules, trace: { traceId: "t1", transitionSeq: 5 } });
```

---

### Task 1: 标签推导（tags.ts）

**Files:**
- Create: `extensions/agent-lab/src/ingest/tags.ts`
- Test: `extensions/agent-lab/test/ingest-tags.test.ts`

**Interfaces:**
- Produces（Task 3 依赖）: `export function deriveTags(relPath: string): string[]` —— 相对路径 → 标签数组（目录段 + 去日期前缀文件名），恒非空

- [ ] **Step 1: Write the failing test**

```typescript
// test/ingest-tags.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTags } from "../src/ingest/tags.ts";

test("多级目录段 + 文件名去日期前缀", () => {
  assert.deepEqual(
    deriveTags("superpowers/specs/2026-08-02-memory-system-design.md"),
    ["superpowers", "specs", "memory-system-design"],
  );
});

test("根直属文件仅文件名标签", () => {
  assert.deepEqual(deriveTags("README.md"), ["README"]);
});

test("无日期前缀文件名原样", () => {
  assert.deepEqual(deriveTags("ptl/authoring.md"), ["ptl", "authoring"]);
});

test("文件名去日期前缀后为空 → 回退去扩展名（锚点恒非空）", () => {
  assert.deepEqual(deriveTags("x/2026-08-02.md"), ["x", "2026-08-02"]);
});

test("./ 前缀与空段被忽略", () => {
  assert.deepEqual(deriveTags("./a//b.md"), ["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-tags.test.ts`
Expected: FAIL（模块不存在 / ERR_MODULE_NOT_FOUND）

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/tags.ts
// 路径推导标签（spec §4.1，纯函数零维护）。
// 规则：目录段原样 + 文件名去扩展名去日期前缀；不做大小写折叠/分词/同义归并
// （标签精化是记忆管理者角色后续工作）。锚点非空不变量：文件名标签恒存在。

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

export function deriveTags(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  const file = parts[parts.length - 1]!;
  const extStripped = file.replace(/\.[^.]*$/, "");
  const dateStripped = extStripped.replace(DATE_PREFIX_RE, "");
  const stem = dateStripped.length > 0 ? dateStripped : extStripped;
  return [...parts.slice(0, -1), stem].filter((t) => t.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-tags.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/ingest/tags.ts extensions/agent-lab/test/ingest-tags.test.ts
git commit -m "feat(agent-lab): 摄入标签推导——纯路径规则：目录段+去日期前缀文件名，锚点恒非空"
```

---

### Task 2: 源适配器（source.ts + docs-source.ts）

**Files:**
- Create: `extensions/agent-lab/src/ingest/source.ts`
- Create: `extensions/agent-lab/src/ingest/docs-source.ts`
- Test: `extensions/agent-lab/test/ingest-docs-source.test.ts`

**Interfaces:**
- Produces（Task 3 依赖）:
  - `export interface SourceDoc { relPath: string; title: string; firstPara: string; contentHash: string; }`
  - `export interface IngestSource { list(): SourceDoc[]; }`
  - `export class DocsSource implements IngestSource` —— `constructor(rootDir: string)`，递归扫 `*.md`，按 relPath 排序
  - `export function parseDoc(relPath: string, text: string): SourceDoc` —— 单文档解析（导出供 Task 3 测试复用）

- [ ] **Step 1: Write the failing test**

```typescript
// test/ingest-docs-source.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DocsSource, parseDoc } from "../src/ingest/docs-source.ts";

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-src-"));
  writeFileSync(path.join(dir, "a.md"), "# 标题 A\n\n第一段内容。\n\n后续段落。\n");
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "nested", "b.md"), "无标题文档\n\n正文。\n");
  writeFileSync(path.join(dir, "nested", "pipe.md"), "# 含竖线|标题\n\n摘要|带竖线。\n");
  writeFileSync(path.join(dir, "long.md"), "# 长文\n\n" + "字".repeat(600) + "\n");
  writeFileSync(path.join(dir, "skip.txt"), "不是 markdown\n");
  return dir;
}

test("DocsSource 递归扫描仅 md、排序、title/firstPara 提取", () => {
  const dir = fixture();
  const docs = new DocsSource(dir).list();
  assert.deepEqual(docs.map((d) => d.relPath), ["a.md", "long.md", "nested/b.md", "nested/pipe.md"]);
  const a = docs.find((d) => d.relPath === "a.md")!;
  assert.equal(a.title, "标题 A");
  assert.equal(a.firstPara, "第一段内容。");
  const b = docs.find((d) => d.relPath === "nested/b.md")!;
  assert.equal(b.title, "b");           // 无 # 标题 → 文件名兜底
  assert.equal(b.firstPara, "无标题文档"); // 标题缺位时首段 = 首个非空行段落
  rmSync(dir, { recursive: true, force: true });
});

test("竖线替换为全角（EBNF 行内分字段兼容）", () => {
  const d = parseDoc("nested/pipe.md", "# 含竖线|标题\n\n摘要|带竖线。\n");
  assert.equal(d.title, "含竖线／标题");
  assert.equal(d.firstPara, "摘要／带竖线。");
});

test("firstPara 截断 500 字符", () => {
  const dir = fixture();
  const docs = new DocsSource(dir).list();
  const long = docs.find((d) => d.relPath === "long.md")!;
  assert.equal(long.firstPara.length, 500);
  rmSync(dir, { recursive: true, force: true });
});

test("contentHash 稳定且随内容变化", () => {
  const d1 = parseDoc("x.md", "# T\n\n正文。\n");
  const d2 = parseDoc("x.md", "# T\n\n正文。\n");
  const d3 = parseDoc("x.md", "# T\n\n正文改了。\n");
  assert.equal(d1.contentHash, d2.contentHash);
  assert.notEqual(d1.contentHash, d3.contentHash);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-docs-source.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND）

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/source.ts
// 源适配器接口（spec §4）：v1 仅仓库 docs 一个实现；接口源无关，
// 未来会话源/外部源（agent-reach）加适配器即可。

export interface SourceDoc {
  relPath: string;      // 相对源根的路径（/ 分隔）
  title: string;        // 首个 `# ` 标题；缺省回退文件名去扩展名；`|` 已替换为 `／`
  firstPara: string;    // 标题后首个非空段落（≤500 字符）；`|` 已替换为 `／`
  contentHash: string;  // sha256(全文)
}

export interface IngestSource {
  list(): SourceDoc[];
}
```

```typescript
// src/ingest/docs-source.ts
// 仓库 docs 源适配器：递归扫描 *.md → SourceDoc（机械提取，零 LLM）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { IngestSource, SourceDoc } from "./source.ts";

const FIRST_PARA_MAX = 500;

export function parseDoc(relPath: string, text: string): SourceDoc {
  const lines = text.split("\n");
  let title = "";
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^#\s+(.+?)\s*$/);
    if (m) { title = m[1]!; titleIdx = i; break; }
  }
  if (!title) {
    const file = relPath.split("/").pop() ?? relPath;
    title = file.replace(/\.[^.]*$/, "");
  }
  // firstPara：标题（或文首）后首个非空段落；遇下一标题停止
  const paraLines: string[] = [];
  let started = false;
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") { if (started) break; continue; }
    if (line.startsWith("#")) break;
    started = true;
    paraLines.push(line);
  }
  const firstPara = paraLines.join(" ").slice(0, FIRST_PARA_MAX);
  return {
    relPath,
    title: title.replaceAll("|", "／"),
    firstPara: (firstPara.length > 0 ? firstPara : "（无摘要）").replaceAll("|", "／"),
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
}

export class DocsSource implements IngestSource {
  constructor(private readonly rootDir: string) {}

  list(): SourceDoc[] {
    const out: SourceDoc[] = [];
    this.walk(this.rootDir, out);
    out.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
    return out;
  }

  private walk(dir: string, out: SourceDoc[]): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { this.walk(full, out); continue; }
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(full, "utf-8");
      out.push(parseDoc(relative(this.rootDir, full).replace(/\\/g, "/"), text));
    }
  }
}
```

注意测试细节：`nested/b.md` 无 `# ` 标题 → `titleIdx = -1` → 首段扫描从第 0 行开始，首个非空行段落 = `无标题文档`（与测试断言一致）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-docs-source.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/ingest/source.ts extensions/agent-lab/src/ingest/docs-source.ts extensions/agent-lab/test/ingest-docs-source.test.ts
git commit -m "feat(agent-lab): 摄入源适配器——IngestSource 接口 + 仓库 docs 实现（标题/首段机械提取、竖线净化、sha256 内容哈希）"
```

---

### Task 3: 指针条目规则 + 摄入管道（rule.ts + pipeline.ts）

**Files:**
- Create: `extensions/agent-lab/src/ingest/rule.ts`
- Create: `extensions/agent-lab/src/ingest/pipeline.ts`
- Test: `extensions/agent-lab/test/ingest-pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 `deriveTags(relPath)`；Task 2 `IngestSource`/`SourceDoc`/`parseDoc`
- Produces（Task 4/5 依赖）:
  - `export const INGEST_POINTER_RULE_ID = "ingest-pointer-rule"`
  - `export function ensureIngestRule(rules: RuleRegistry): string` —— 幂等注册指针条目构造规则，返回 rule id
  - `export function pointerEntryId(relPath: string): string` —— 确定性 UUID 形态 id
  - `export function buildPointerContent(doc: SourceDoc): string`
  - `export interface IngestSummary { scanned: number; created: number; updated: number; skipped: number; changed: SourceDoc[]; }`
  - `export class IngestPipeline` —— `constructor(deps: { source: IngestSource; store: MemoryStore; memPipeline: MemoryPipeline; ruleId: string })`，`run(): IngestSummary`

- [ ] **Step 1: Write the failing test**

```typescript
// test/ingest-pipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { parseDoc } from "../src/ingest/docs-source.ts";
import type { IngestSource, SourceDoc } from "../src/ingest/source.ts";
import { ensureIngestRule, INGEST_POINTER_RULE_ID } from "../src/ingest/rule.ts";
import { IngestPipeline, pointerEntryId, buildPointerContent } from "../src/ingest/pipeline.ts";

class FakeSource implements IngestSource {
  constructor(public docs: SourceDoc[]) {}
  list(): SourceDoc[] { return this.docs; }
}

function fresh(docs: SourceDoc[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-pipe-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const ruleId = ensureIngestRule(rules);
  const memPipeline = new MemoryPipeline({ dir, store, rules, trace: { traceId: "ingest-test", transitionSeq: 1 } });
  const pipeline = new IngestPipeline({ source: new FakeSource(docs), store, memPipeline, ruleId });
  return { dir, store, pipeline };
}

const docA = parseDoc("superpowers/specs/2026-08-02-memory-system-design.md", "# 记忆系统设计\n\n三层记忆结构。\n");
const docB = parseDoc("ptl/authoring.md", "# 模板开发\n\nPTL 开发指南。\n");

test("首次运行全部 created，条目形态符合 spec §4.2", () => {
  const { pipeline, store, dir } = fresh([docA, docB]);
  const s = pipeline.run();
  assert.deepEqual({ scanned: s.scanned, created: s.created, updated: s.updated, skipped: s.skipped }, { scanned: 2, created: 2, updated: 0, skipped: 0 });
  assert.equal(s.changed.length, 2);
  const e = store.get(pointerEntryId(docA.relPath))!;
  assert.equal(e.kind, "fact");
  assert.equal(e.status, "official");
  assert.deepEqual(e.anchors, ["superpowers", "specs", "memory-system-design"]);
  assert.equal(e.content, buildPointerContent(docA));
  assert.ok(e.content.includes("源: superpowers/specs/2026-08-02-memory-system-design.md"));
  assert.equal(e.ruleRef, INGEST_POINTER_RULE_ID);
  rmSync(dir, { recursive: true, force: true });
});

test("二连跑幂等：全部 skipped，条目数不变", () => {
  const { pipeline, store, dir } = fresh([docA, docB]);
  pipeline.run();
  const before = store.listIds().length;
  const s2 = pipeline.run();
  assert.equal(s2.skipped, 2);
  assert.equal(s2.created + s2.updated, 0);
  assert.equal(s2.changed.length, 0);
  assert.equal(store.listIds().length, before);
  rmSync(dir, { recursive: true, force: true });
});

test("文档变更 → updated：同 id 版本 +1，changed 携带该文档", () => {
  const { pipeline, store, dir } = fresh([docA]);
  pipeline.run();
  const id = pointerEntryId(docA.relPath);
  assert.equal(store.get(id)!.meta.version, 1);
  const changed = parseDoc(docA.relPath, "# 记忆系统设计\n\n三层记忆结构，已修订。\n");
  (pipeline as unknown as { deps: { source: FakeSource } }).deps.source.docs = [changed];
  const s2 = pipeline.run();
  assert.deepEqual({ created: s2.created, updated: s2.updated, skipped: s2.skipped }, { created: 0, updated: 1, skipped: 0 });
  const e = store.get(id)!;
  assert.equal(e.meta.version, 2);
  assert.ok(e.content.includes("已修订"));
  assert.equal(s2.changed[0]!.relPath, docA.relPath);
  rmSync(dir, { recursive: true, force: true });
});

test("ensureIngestRule 幂等：重复调用不抛、不重复注册", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-rule-"));
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  assert.equal(ensureIngestRule(rules), INGEST_POINTER_RULE_ID);
  assert.equal(ensureIngestRule(rules), INGEST_POINTER_RULE_ID);
  rmSync(dir, { recursive: true, force: true });
});

test("指针条目可被锚点检索命中", () => {
  const { pipeline, store, dir } = fresh([docA]);
  pipeline.run();
  const hits = store.retrieve({ anchors: ["memory-system-design"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, pointerEntryId(docA.relPath));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-pipeline.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：rule.ts/pipeline.ts 不存在）

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/rule.ts
// 指针条目构造规则注册（spec §4.2，幂等）。
// EBNF 校验为行级 token：每非空行按 "|" 拆字段、对主生产式匹配；
// 指针内容每行恰一个字段（标题/摘要/源指针），`pointer = word ;` 匹配任意非空字段。
// "|" 已在 docs-source 净化为 "／"，内容不含字段分隔符。

import { AXIOM_RULE_ID, createEntry } from "../memory/entry.ts";
import type { RuleRegistry } from "../memory/rules.ts";

export const INGEST_POINTER_RULE_ID = "ingest-pointer-rule";

export function ensureIngestRule(rules: RuleRegistry): string {
  if (rules.resolveRule(INGEST_POINTER_RULE_ID)) return INGEST_POINTER_RULE_ID;
  const rule = createEntry({
    id: INGEST_POINTER_RULE_ID,
    kind: "rule",
    anchors: ["ingest.pointer"],
    content: "pointer = word ;",
    ruleRef: AXIOM_RULE_ID,
  });
  const errors = rules.registerRule(rule);
  if (errors.length > 0) throw new Error(`register ingest rule failed: ${errors.join("; ")}`);
  return INGEST_POINTER_RULE_ID;
}
```

```typescript
// src/ingest/pipeline.ts
// 摄入管道（spec §4）：源扫描 → 指针条目（create/update/skip）。
// 机械、确定性、幂等——不经 agent；文档层进入记忆系统的唯一接口。
// 增量判定：内容相等 ⟺ 无变更（内容由 SourceDoc 确定性构造）。

import { createHash } from "node:crypto";
import type { MemoryPipeline } from "../memory/pipeline.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { IngestSource, SourceDoc } from "./source.ts";
import { deriveTags } from "./tags.ts";

export interface IngestSummary {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  /** created + updated 的文档——cycle 用其派发语义分解任务 */
  changed: SourceDoc[];
}

export interface IngestPipelineDeps {
  source: IngestSource;
  store: MemoryStore;
  memPipeline: MemoryPipeline;
  ruleId: string;
}

/** 确定性条目 id：relPath → sha256 → UUID 形态（同文档恒同 id）。 */
export function pointerEntryId(relPath: string): string {
  const hex = createHash("sha256").update(`ingest-pointer:${relPath}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildPointerContent(doc: SourceDoc): string {
  return `# ${doc.title}\n\n${doc.firstPara}\n\n源: ${doc.relPath}`;
}

export class IngestPipeline {
  constructor(private readonly deps: IngestPipelineDeps) {}

  run(): IngestSummary {
    const docs = this.deps.source.list();
    const summary: IngestSummary = { scanned: docs.length, created: 0, updated: 0, skipped: 0, changed: [] };
    for (const doc of docs) {
      const id = pointerEntryId(doc.relPath);
      const content = buildPointerContent(doc);
      const existing = this.deps.store.get(id);
      if (existing && existing.content === content) { summary.skipped++; continue; }
      const r = this.deps.memPipeline.write({
        id,
        kind: "fact",
        anchors: deriveTags(doc.relPath),
        content,
        ruleRef: this.deps.ruleId,
        status: "official",
        idempotencyKey: `ingest:${doc.relPath}:${doc.contentHash}`,
      });
      if (!r.ok) throw new Error(`ingest ${doc.relPath} failed: ${r.errors.join("; ")}`);
      if (existing) summary.updated++; else summary.created++;
      summary.changed.push(doc);
    }
    return summary;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-pipeline.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/ingest/rule.ts extensions/agent-lab/src/ingest/pipeline.ts extensions/agent-lab/test/ingest-pipeline.test.ts
git commit -m "feat(agent-lab): 摄入管道——指针条目构造规则注册（幂等）+确定性条目 id+create/update/skip 增量语义，校验/幂等/溯源/事件复用 MemoryPipeline"
```

---

### Task 4: 周期流（cycle.ts）

**Files:**
- Create: `extensions/agent-lab/src/ingest/cycle.ts`
- Test: `extensions/agent-lab/test/ingest-cycle.test.ts`

**Interfaces:**
- Consumes: Task 3 `IngestPipeline`/`IngestSummary`；既有 `DispatchRequest`（scheduler/runner-types.ts）
- Produces（Task 5 集成依赖）:
  - `export const MEMORY_MAINTENANCE_ROLE = "memory-maintenance"`
  - `export function semanticSplitTask(relPath: string): string` —— 语义分解任务文本（内嵌协议，spec §6）
  - `export interface IngestCycleDeps { pipeline: IngestPipeline; dispatch: (req: DispatchRequest) => Promise<unknown>; intervalMs: number; role?: string; }`
  - `export async function runIngestCycleOnce(deps: IngestCycleDeps): Promise<IngestSummary>` —— 单轮：跑管道 + 为 changed 逐个派发
  - `export function startIngestCycle(deps: IngestCycleDeps): { stop(): void }` —— setInterval + unref（不阻进程退出，MemoryHost 既有惯例）

- [ ] **Step 1: Write the failing test**

```typescript
// test/ingest-cycle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DispatchRequest } from "../src/scheduler/runner-types.ts";
import type { IngestPipeline, IngestSummary } from "../src/ingest/pipeline.ts";
import type { SourceDoc } from "../src/ingest/source.ts";
import { parseDoc } from "../src/ingest/docs-source.ts";
import { runIngestCycleOnce, startIngestCycle, semanticSplitTask, MEMORY_MAINTENANCE_ROLE } from "../src/ingest/cycle.ts";

const docA = parseDoc("ptl/authoring.md", "# 模板开发\n\n指南。\n");

function fakePipeline(changed: SourceDoc[]): IngestPipeline {
  return { run: (): IngestSummary => ({ scanned: changed.length, created: changed.length, updated: 0, skipped: 0, changed }) } as unknown as IngestPipeline;
}

test("单轮：changed 逐文档派发，参数符合 spec（weighted 路由 + 执行模式）", async () => {
  const calls: DispatchRequest[] = [];
  const summary = await runIngestCycleOnce({
    pipeline: fakePipeline([docA]),
    dispatch: async (req) => { calls.push(req); return { status: "completed" }; },
    intervalMs: 60_000,
  });
  assert.equal(summary.created, 1);
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.role, MEMORY_MAINTENANCE_ROLE);
  assert.equal(req.task, semanticSplitTask(docA.relPath));
  assert.ok(req.task.includes("ptl/authoring.md"));
  assert.ok(req.task.includes("sdk.memory.write"));
  assert.equal(req.labels?.strategy, "weighted");
  assert.equal(req.labels?.relPath, docA.relPath);
  assert.equal(req.caller, "ingest-cycle");
  assert.equal(req.taskCategory, "memory-maintenance");
  assert.equal(req.mode, "execute");
  assert.ok(req.traceId.startsWith("ingest-cycle:"));
});

test("无增量不派发", async () => {
  const calls: DispatchRequest[] = [];
  await runIngestCycleOnce({
    pipeline: fakePipeline([]),
    dispatch: async (req) => { calls.push(req); },
    intervalMs: 60_000,
  });
  assert.equal(calls.length, 0);
});

test("role 可覆盖", async () => {
  const calls: DispatchRequest[] = [];
  await runIngestCycleOnce({
    pipeline: fakePipeline([docA]),
    dispatch: async (req) => { calls.push(req); },
    intervalMs: 60_000,
    role: "custom-role",
  });
  assert.equal(calls[0]!.role, "custom-role");
});

test("startIngestCycle 返回 stop，stop 后不再触发", async () => {
  const handle = startIngestCycle({
    pipeline: fakePipeline([]),
    dispatch: async () => { throw new Error("不应被调用"); },
    intervalMs: 60_000,
  });
  handle.stop();
  // 无定时器泄漏即通过（unref + stop 后进程不挂起——node:test 自身会因挂起超时报错）
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-cycle.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND）

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ingest/cycle.ts
// 周期流（spec §5 实现选择 b）：摄入模块自带周期定时器——机械行为不进 agent 路径。
// 每轮：跑摄入管道 → 为每个变更文档派发"语义分解"任务（labels.strategy="weighted"
// 经 resolveStrategy 第 2 级路由）。单轮失败不破坏周期：下轮幂等重试。

import type { DispatchRequest } from "../scheduler/runner-types.ts";
import type { IngestPipeline, IngestSummary } from "./pipeline.ts";

export const MEMORY_MAINTENANCE_ROLE = "memory-maintenance";

/** 语义分解任务文本（内嵌协议，spec §6）。 */
export function semanticSplitTask(relPath: string): string {
  return `语义分解 ${relPath}：读取该文档，识别可独立成立的语义事实（定义/决策/规则/结论/不变量），每条经 sdk.memory.write 写一个 MemoryEntry（kind=fact，anchors=文档标签+更细主题锚点，content=事实本身，末尾附 "源: ${relPath}"）。不改写原文档、不删除指针条目。`;
}

export interface IngestCycleDeps {
  pipeline: IngestPipeline;
  dispatch: (req: DispatchRequest) => Promise<unknown>;
  intervalMs: number;
  role?: string;
}

export async function runIngestCycleOnce(deps: IngestCycleDeps): Promise<IngestSummary> {
  const summary = deps.pipeline.run();
  const role = deps.role ?? MEMORY_MAINTENANCE_ROLE;
  for (const doc of summary.changed) {
    await deps.dispatch({
      traceId: `ingest-cycle:${Date.now()}:${doc.relPath}`,
      role,
      task: semanticSplitTask(doc.relPath),
      taskCategory: "memory-maintenance",
      caller: "ingest-cycle",
      labels: { strategy: "weighted", relPath: doc.relPath },
      mode: "execute",
    });
  }
  return summary;
}

export function startIngestCycle(deps: IngestCycleDeps): { stop(): void } {
  const timer = setInterval(() => {
    runIngestCycleOnce(deps).catch(() => {
      // 单轮失败静默跳过：下轮幂等重试（管道内容相等判定保证不重复写）
    });
  }, deps.intervalMs);
  timer.unref(); // 定时器不阻进程退出（MemoryHost 既有惯例）
  return { stop() { clearInterval(timer); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-cycle.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/ingest/cycle.ts extensions/agent-lab/test/ingest-cycle.test.ts
git commit -m "feat(agent-lab): 摄入周期流——模块自带定时器（unref），增量文档自动派发语义分解任务（labels.strategy=weighted 路由，机械行为不进 agent 路径）"
```

---

### Task 5: barrel + 端到端集成 + 全量回归

**Files:**
- Create: `extensions/agent-lab/src/ingest/index.ts`
- Test: `extensions/agent-lab/test/ingest-integration.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部导出

- [ ] **Step 1: Write barrel + the failing integration test**

```typescript
// src/ingest/index.ts
// 摄入域公共接口（域内 barrel，与 memory/index.ts 惯例一致）。
export * from "./tags.ts";
export * from "./source.ts";
export * from "./docs-source.ts";
export * from "./rule.ts";
export * from "./pipeline.ts";
export * from "./cycle.ts";
```

```typescript
// test/ingest-integration.test.ts
// 端到端集成（spec §9）：真实 docs 树 → DocsSource → IngestPipeline（真实 MemoryStore/Pipeline）
// → 锚点检索 → 热度旁路 → 周期流派发。PI 风格隔离目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { DocsSource } from "../src/ingest/docs-source.ts";
import { ensureIngestRule } from "../src/ingest/rule.ts";
import { IngestPipeline, pointerEntryId } from "../src/ingest/pipeline.ts";
import { runIngestCycleOnce } from "../src/ingest/cycle.ts";
import type { DispatchRequest } from "../src/scheduler/runner-types.ts";

function fixtureDocs(): string {
  const docs = mkdtempSync(path.join(tmpdir(), "ingest-docs-"));
  writeFileSync(path.join(docs, "guide.md"), "# 使用指南\n\n这是使用指南的摘要。\n\n正文若干。\n");
  mkdirSync(path.join(docs, "specs"));
  writeFileSync(path.join(docs, "specs", "2026-08-06-demo-design.md"), "# Demo 设计\n\n设计摘要。\n");
  return docs;
}

function freshMem() {
  const memDir = mkdtempSync(path.join(tmpdir(), "ingest-mem-"));
  const store = new MemoryStore(memDir);
  const rules = new RuleRegistry(memDir);
  rules.bootstrapAxiom();
  const ruleId = ensureIngestRule(rules);
  const memPipeline = new MemoryPipeline({ dir: memDir, store, rules, trace: { traceId: "ingest-int", transitionSeq: 1 } });
  return { memDir, store, ruleId, memPipeline };
}

test("端到端：摄入→幂等→增量→检索→热度→派发", async () => {
  const docsDir = fixtureDocs();
  const { memDir, store, ruleId, memPipeline } = freshMem();
  const pipeline = new IngestPipeline({ source: new DocsSource(docsDir), store, memPipeline, ruleId });

  // 1. 首轮：全部 created
  const s1 = pipeline.run();
  assert.deepEqual({ scanned: s1.scanned, created: s1.created }, { scanned: 2, created: 2 });

  // 2. 二轮：全部 skipped（幂等）
  const s2 = pipeline.run();
  assert.equal(s2.skipped, 2);
  assert.equal(s2.changed.length, 0);

  // 3. 改动文档 → updated + 版本递增
  appendFileSync(path.join(docsDir, "guide.md"), "\n新增段落。\n");
  const s3 = pipeline.run();
  assert.deepEqual({ created: s3.created, updated: s3.updated, skipped: s3.skipped }, { created: 0, updated: 1, skipped: 1 });
  const id = pointerEntryId("guide.md");
  assert.equal(store.get(id)!.meta.version, 2);

  // 4. 锚点检索命中
  const hits = store.retrieve({ anchors: ["demo-design"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, pointerEntryId("specs/2026-08-06-demo-design.md"));
  assert.ok(hits[0]!.content.includes("源: specs/2026-08-06-demo-design.md"));

  // 5. 热度旁路：bumpHitCount 两次 → 计数 2
  store.bumpHitCount(id);
  store.bumpHitCount(id);
  const counterFile = path.join(memDir, "counters", `${id}.json`);
  assert.ok(existsSync(counterFile));
  assert.equal(JSON.parse(readFileSync(counterFile, "utf-8")).hitCount, 2);

  // 6. 周期流：改文档后单轮 → 为变更文档派发语义分解任务
  const calls: DispatchRequest[] = [];
  appendFileSync(path.join(docsDir, "guide.md"), "\n再改一次。\n");
  await runIngestCycleOnce({ pipeline, dispatch: async (req) => { calls.push(req); }, intervalMs: 60_000 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.task.includes("guide.md"));
  assert.equal(calls[0]!.labels?.strategy, "weighted");

  rmSync(docsDir, { recursive: true, force: true });
  rmSync(memDir, { recursive: true, force: true });
});
```

注意：热度计数器文件路径 `counters/<id>.json` 若与实现不符，以 `store.ts` 的 `counterPath` 实际布局为准（读 store.ts 确认后调整断言——这是唯一允许的测试侧适配点）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-integration.test.ts`
Expected: FAIL（barrel 缺失导致 ERR_MODULE_NOT_FOUND，或计数器路径断言失败）

- [ ] **Step 3: Make it pass**

barrel 已在 Step 1 写好；若计数器路径断言失败，读 `src/memory/store.ts` 的 `counterPath` 修正断言（不改实现）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-integration.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归**

```bash
cd extensions/agent-lab && npm test          # 期望：仅 weighted-scorer-bootstrap 2 个既有失败
cd /Users/anzhize/pi-platform && npx vitest run   # 期望：全绿
npm run lint                                  # 期望：干净
```

- [ ] **Step 6: Commit**

```bash
git add extensions/agent-lab/src/ingest/index.ts extensions/agent-lab/test/ingest-integration.test.ts
git commit -m "feat(agent-lab): 摄入域 barrel + 端到端集成——真实 docs 树摄入/幂等/增量/锚点检索/热度旁路/周期流派发全链路验证"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§2 目标 1（摄入管道）→ Task 1-3；目标 2（检索与热度）→ Task 3 Step 1 检索断言 + Task 5 热度断言；目标 3（投递窗口）→ 定时投递 = Task 4 周期流（spec §5 选择 b），PTL 投递 = 既有 `/lab scheduler dispatch`（无新代码，命令层已在打磨计划交付并有测试）；目标 4（语义分解任务类型）→ Task 4 `semanticSplitTask` + 派发参数断言（agent 真实执行为环境前置项，spec §8 已声明）。§4.1 标签规则 → Task 1；§4.2 指针条目 → Task 3；§6 任务协议 → Task 4；§9 测试策略 → 各 Task + Task 5。非目标项零代码。**无缺口。**
2. **占位符扫描**：无 TBD/TODO；每步有代码；Task 5 计数器路径适配点已明示规则（只改测试断言，不改实现）。
3. **类型一致性**：`SourceDoc`/`IngestSummary`/`IngestCycleDeps`/`pointerEntryId`/`buildPointerContent`/`ensureIngestRule`/`MEMORY_MAINTENANCE_ROLE`/`semanticSplitTask` 跨任务签名一致；`DispatchRequest` 字段照 runner-types.ts 现状（labels.strategy/mode/taskCategory/caller 均为既有字段）。
