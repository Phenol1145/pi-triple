// 沉淀管道（spec §4）：缓冲 / 幂等 / 草稿区 TTL / promote / 溯源 / 事件。
//
// 文件布局（关键约束）：
//   dir/buffer.jsonl            observe 追加 {key, content, anchors, kind?, ts}
//   dir/idem.jsonl              write 成功追加 {key, entryId}（幂等键表）
//   dir/buffer-consumed.jsonl   write 成功追加 {key}（消费标记，不重置）
//   dir/retry-count.jsonl       write 失败计数 {key, count}（封顶 RETRY_LIMIT）
//
// 语义（spec §4 + 第三/四轮评审裁决）：
//   - observe 预分配 idempotencyKey（UUID）入缓冲 → 返回 key
//   - write 幂等：key 命中幂等表 → 返回已有条目（重放不重复）
//   - 校验失败三级处置：返回错误（生产式定位，来自 rules.validateContent）
//     → 草稿区（status: draft, ttlExpiresAt = now + 7d，不静默丢）
//     → 反馈重试 ≤2 次（retry-count 计数 1/2），第 3 次起直接草稿区且不再计数
//   - 成功 → 溯源附加（sourceTraces 追加 {traceId, transitionSeq}）→ 落库
//     → 幂等表追加 → 缓冲消费标记（条目先、标记后、索引最后，由 store 保证）
//   - promote：同 id 新版本（version 延续）+ promotedFrom + 草稿 sourceTraces
//     并入 + 新 idempotencyKey（注册进幂等表）；草稿 TTL 使命结束（清除）
//   - 事件：先落库、后回调（spec §4.3 事件-落库顺序；事件表落盘留 Task 9 审计扩展）
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEntry, validateEntryStructure } from "./entry.ts";
import type { MemoryEntry, MemoryKind } from "./entry.ts";
import type { MemoryStore } from "./store.ts";
import type { RuleRegistry } from "./rules.ts";

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 草稿区 TTL = now + 7 天
const RETRY_LIMIT = 2; // 反馈重试 ≤2 次；第 3 次起直接草稿区且不再计数

/** 溯源轨迹（write 成功时追加进 sourceTraces；由调用方经构造参数传入）。 */
export interface PipelineTrace {
  traceId: string;
  transitionSeq: number;
}

/** memory_tx 事件（v1 直接回调；事件表落盘留 Task 9 审计扩展）。 */
export interface PipelineEvent {
  type: "memory_tx";
  action: "write" | "draft";
  ok: boolean;
  entryId: string;
  idempotencyKey: string;
  errors?: string[];
  at: number;
}

export interface PipelineDeps {
  dir: string; // 记忆库目录（与 MemoryStore/RuleRegistry 同 dir——管道文件布局所在）
  store: MemoryStore;
  rules: RuleRegistry;
  trace: PipelineTrace;
  now?: () => number;
  onEvent?: (ev: PipelineEvent) => void;
}

interface IdemRecord { key: string; entryId: string; watermark?: number; }
interface BufferRecord { key: string; content: string; anchors: string[]; kind?: string; ts: number; }
interface ConsumedRecord { key: string; }
interface RetryRecord { key: string; count: number; }

export class MemoryPipeline {
  private deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  private file(name: string): string {
    return join(this.deps.dir, name);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private ensureDir(): void {
    mkdirSync(this.deps.dir, { recursive: true });
  }

  private appendJsonl(filePath: string, rec: unknown): void {
    this.ensureDir();
    appendFileSync(filePath, JSON.stringify(rec) + "\n");
  }

  private readJsonl<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return [];
    const out: T[] = [];
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // 损坏行跳过（append-only 日志容错；不静默删文件）
      }
    }
    return out;
  }

  /** 整文件重写（tmp+rename 原子写；仅用于 retry-count 封顶维护与 flushBuffer）。 */
  private rewriteJsonl(filePath: string, recs: unknown[]): void {
    this.ensureDir();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, recs.map((r) => JSON.stringify(r)).join("\n") + (recs.length > 0 ? "\n" : ""));
    renameSync(tmpPath, filePath);
  }

  /** 入缓冲：预分配 idempotencyKey（UUID）→ 追加 dir/buffer.jsonl → 返回 key。 */
  observe(observation: { content: string; anchors: string[]; kind?: MemoryKind }): string {
    const key = randomUUID();
    const rec: BufferRecord = {
      key,
      content: observation.content,
      anchors: observation.anchors,
      ...(observation.kind !== undefined ? { kind: observation.kind } : {}),
      ts: Date.now(),
    };
    this.appendJsonl(this.file("buffer.jsonl"), rec);
    return key;
  }

  /**
   * 沉淀写入：
   * - key 命中幂等表 → 返回已有条目（幂等，重放不重复）
   * - 未命中 → 校验链（validateEntryStructure + rules.validateContent）
   * - 失败 → 草稿区（status: draft, ttl = now + 7d）+ 错误返回；前 2 次失败计数，
   *   第 3 次起直接草稿区且不再计数（retry-count.jsonl 封顶 RETRY_LIMIT）
   * - 成功 → 溯源附加 → 落库 → 幂等表追加 → 缓冲消费标记 → 事件（先落库后事件）
   */
  write(entry: { idempotencyKey: string } & Partial<MemoryEntry>): { ok: true; entry: MemoryEntry } | { ok: false; errors: string[]; draft?: MemoryEntry } {
    const key = entry.idempotencyKey;
    if (!key) {
      return { ok: false, errors: ["idempotencyKey is required"] };
    }

    // 幂等：key 已存在 → 返回已有条目
    const hit = this.idemLookup(key);
    if (hit) {
      const existing = this.deps.store.get(hit.entryId);
      if (existing) return { ok: true, entry: existing };
      // 键表命中但条目缺失（不一致状态）→ 按未命中重处理
    }

    // 重试上限：同 key 已失败 ≥2 次（第 3 次起）→ 直接草稿区，不再计数
    if (this.retryCount(key) >= RETRY_LIMIT) {
      const errors = [`retry limit exceeded (${RETRY_LIMIT + 1} attempts) for idempotencyKey ${key}`];
      const draft = this.sinkDraft(entry, errors);
      return { ok: false, errors, draft };
    }

    const candidate = createEntry(entry as Parameters<typeof createEntry>[0]);
    const errors = [...validateEntryStructure(candidate), ...this.deps.rules.validateContent(candidate)];
    if (errors.length > 0) {
      this.incrementRetry(key); // 前 2 次失败计数（第 3 次起由上方熔断拦截，不再计数）
      const draft = this.sinkDraft(entry, errors);
      return { ok: false, errors, draft };
    }

    // 成功：溯源附加 → 落库 → 幂等表 → 消费标记 → 事件（先落库后事件）
    const traced: MemoryEntry = {
      ...candidate,
      meta: {
        ...candidate.meta,
        sourceTraces: [
          ...(candidate.meta.sourceTraces ?? []),
          { traceId: this.deps.trace.traceId, transitionSeq: this.deps.trace.transitionSeq },
        ],
      },
    };
    this.deps.store.write(traced);
    this.appendJsonl(this.file("idem.jsonl"), { key, entryId: traced.id, watermark: this.deps.trace.transitionSeq });
    this.appendJsonl(this.file("buffer-consumed.jsonl"), { key });
    this.clearRetry(key);
    this.deps.onEvent?.({ type: "memory_tx", action: "write", ok: true, entryId: traced.id, idempotencyKey: key, at: this.now() });
    return { ok: true, entry: traced };
  }

  /**
   * 显式 promote：同 id 新版本（version 延续）+ promotedFrom + 草稿 sourceTraces
   * 并入 + 新 idempotencyKey（注册进幂等表）；草稿 TTL 使命结束（清除）。
   * 返回错误数组（空 = 成功）。
   * not-write-back 校验（写校验链拒绝）：草稿条目（或其来源 promotedFrom 条目）带
   * meta.notWriteBack 或命中 dir/not-write-back.jsonl 标记 → 拒绝（不可回写条目）。
   */
  promote(draftId: string, content: string): string[] {
    const draft = this.deps.store.get(draftId);
    if (!draft) return [`draft not found: ${draftId}`];
    if (draft.status !== "draft") return [`entry ${draftId} is not a draft`];

    // 写校验链拒绝：引用审核动作的条目标记不可回写（spec §6）
    const blocked = this.notWriteBackBlockedId(draft);
    if (blocked !== undefined) return [`not write-back: ${blocked}`];

    // 校验新 content（结构 + 规则链，复用 write 的校验语义）
    const candidate = createEntry({ ...draft, content } as Parameters<typeof createEntry>[0]);
    const errors = [...validateEntryStructure(candidate), ...this.deps.rules.validateContent(candidate)];
    if (errors.length > 0) return errors;

    const newKey = randomUUID();
    this.deps.store.update(draftId, {
      content,
      status: "official",
      promotedFrom: draftId,
      idempotencyKey: newKey,
      ttlExpiresAt: undefined, // 清除草稿 TTL（official 条目不携带过期语义）
      meta: { sourceTraces: [...draft.meta.sourceTraces] }, // 草稿 sourceTraces 并入
    });
    this.appendJsonl(this.file("idem.jsonl"), { key: newKey, entryId: draftId, watermark: this.deps.trace.transitionSeq });
    return [];
  }

  /**
   * 消费缓冲：重写 dir/buffer.jsonl，仅保留未被消费的观察
   * （消费标记 dir/buffer-consumed.jsonl 保留不重置——重落库语义）。
   * write 调用后调用；崩溃重放由 checkpoint 恢复驱动（v1 落点）。
   */
  flushBuffer(): void {
    const consumed = new Set(this.readJsonl<ConsumedRecord>(this.file("buffer-consumed.jsonl")).map((r) => r.key));
    const remaining = this.readJsonl<BufferRecord>(this.file("buffer.jsonl")).filter((r) => !consumed.has(r.key));
    this.rewriteJsonl(this.file("buffer.jsonl"), remaining);
  }

  /**
   * 幂等键表水位 prune（契约②，spec §4.3）：resume 到目标 checkpoint seq 时调用。
   * 丢弃晚于 S 的键表增量：只删 watermark **已定义且 > seq** 的记录（这些键对应的
   * 条目在 resume 后被水位屏蔽/回滚——防"键存在但条目已回滚"不对称；删除后重放
   * write 不再幂等命中被屏蔽条目 → 重新落库复活）。watermark 缺失（旧行，无此字段，
   * 视为 0）→ 0 > seq 恒假 → 保留（保守保留永不误删，第三轮裁决：旧行视为 0）。
   * 返回删除条数。落盘 = tmp+rename 原子重写（对齐 dedup.jsonl prune 先例）。
   */
  pruneIdem(seq: number): number {
    const recs = this.readJsonl<IdemRecord>(this.file("idem.jsonl"));
    const remaining = recs.filter((r) => r.watermark === undefined || r.watermark <= seq);
    const deleted = recs.length - remaining.length;
    if (deleted > 0) {
      this.rewriteJsonl(this.file("idem.jsonl"), remaining);
    }
    return deleted;
  }

  // ---- 内部：幂等表 / 重试计数 / 草稿区 ----

  private idemLookup(key: string): IdemRecord | undefined {
    return this.readJsonl<IdemRecord>(this.file("idem.jsonl")).find((r) => r.key === key);
  }

  /** not-write-back 标记集（dir/not-write-back.jsonl；审核链 markNotWriteBack 写入；损坏行跳过）。 */
  private notWriteBackIds(): Set<string> {
    const p = this.file("not-write-back.jsonl");
    if (!existsSync(p)) return new Set();
    const ids = new Set<string>();
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        const rec = JSON.parse(t) as { entryId?: unknown };
        if (typeof rec.entryId === "string") ids.add(rec.entryId);
      } catch {
        // 损坏行跳过（append-only 日志容错，同 readJsonl）
      }
    }
    return ids;
  }

  /** 不可回写拦截：草稿自身或其来源条目（promotedFrom）带 meta.notWriteBack 或命中标记文件 → 返回被拦条目 id。 */
  private notWriteBackBlockedId(draft: MemoryEntry): string | undefined {
    const candidates = draft.promotedFrom !== undefined ? [draft.id, draft.promotedFrom] : [draft.id];
    const marked = this.notWriteBackIds();
    for (const id of candidates) {
      const entry = this.deps.store.get(id);
      if (entry !== undefined && entry.meta.notWriteBack === true) return id;
      if (marked.has(id)) return id;
    }
    return undefined;
  }

  private retryCount(key: string): number {
    return this.readJsonl<RetryRecord>(this.file("retry-count.jsonl")).find((r) => r.key === key)?.count ?? 0;
  }

  /** 失败计数 +1（仅在前 2 次失败时调用；封顶 RETRY_LIMIT）。 */
  private incrementRetry(key: string): void {
    const recs = this.readJsonl<RetryRecord>(this.file("retry-count.jsonl"));
    const rec = recs.find((r) => r.key === key);
    if (rec) rec.count += 1;
    else recs.push({ key, count: 1 });
    this.rewriteJsonl(this.file("retry-count.jsonl"), recs);
  }

  /** 成功写入后清除该 key 的失败计数（幂等表已接管去重）。 */
  private clearRetry(key: string): void {
    const recs = this.readJsonl<RetryRecord>(this.file("retry-count.jsonl"));
    if (!recs.some((r) => r.key === key)) return;
    this.rewriteJsonl(this.file("retry-count.jsonl"), recs.filter((r) => r.key !== key));
  }

  /** 沉入草稿区：store.write（status: draft, ttl = now + 7d）+ 失败事件（先落库后事件）。 */
  private sinkDraft(input: { idempotencyKey: string } & Partial<MemoryEntry>, errors: string[]): MemoryEntry {
    const draft = createEntry({
      ...(input as Partial<MemoryEntry>),
      status: "draft",
      ttlExpiresAt: this.now() + DRAFT_TTL_MS,
    } as Parameters<typeof createEntry>[0]);
    this.deps.store.write(draft);
    this.deps.onEvent?.({ type: "memory_tx", action: "draft", ok: false, entryId: draft.id, idempotencyKey: input.idempotencyKey, errors, at: this.now() });
    return draft;
  }
}
