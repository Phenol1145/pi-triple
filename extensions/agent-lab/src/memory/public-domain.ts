import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./entry.ts";
import { MemoryStore } from "./store.ts";

/**
 * 公域 fork-merge（spec §6 / plan Task 8）。
 *
 * 语义（spec §2 不变量 3 + 第五轮裁决，钉死）：
 * - entry-overlap 判定谓词：条目 id 相同即冲突；anchors 重叠但 id 不同 = 不冲突（同锚多条目允许）
 * - generation 仅作快照标识/游标（不参与冲突判定——冲突判定只按 id 重叠）；
 *   提交 baseGeneration 必须等于当前 generation（不一致 → generation-stale）
 * - fast-forward：不重叠 delta 零冲突合入 + generation 原子递增（单写者 merge 队列，v1 进程内锁）
 * - 重试耗尽 → 死信区（事件留痕 + operator 处置，不静默丢）——死信区记录由调用方 push
 *   （提交方重试 ≤3 由调用方管；本模块提供 addDeadLetter 写入 + deadLetter() 查询）
 *
 * 文件布局（复用 MemoryStore 布局——内部持 MemoryStore 实例）：
 *   dir/generation.json    库级 generation（快照标识/游标）
 *   dir/entries/           条目（MemoryStore 布局，含 index/ counters/）
 *   dir/deadletter.jsonl   死信区（append-only JSONL）
 */
export type WriteBackResult =
  | { ok: true; generation: number }
  | { ok: false; reason: "conflict" | "overlap" | "generation-stale" | "not-write-back"; detail: string };

export interface SubmitWriteBackOpts {
  baseGeneration: number;
  delta: MemoryEntry[];
  removeIds?: string[];
}

export interface DeadLetterRecord {
  deltaId: string;
  reason: string;
  at: number;
}

export class PublicDomainStore {
  private dir: string;
  private store: MemoryStore;
  /** merge 序列化：v1 单进程内同步锁 + 队列（单写者 merge 队列；JS 单线程下临界区天然原子）。 */
  private mergeLock = false;
  private mergeQueue: Array<() => void> = [];

  constructor(dir: string) {
    this.dir = dir;
    this.store = new MemoryStore(dir);
  }

  private generationPath(): string {
    return join(this.dir, "generation.json");
  }

  /** not-write-back 标记集（dir/not-write-back.jsonl；审核链 markNotWriteBack 写入；损坏行跳过）。 */
  private notWriteBackIds(): Set<string> {
    const p = join(this.dir, "not-write-back.jsonl");
    if (!existsSync(p)) return new Set();
    const ids = new Set<string>();
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      try {
        const rec = JSON.parse(t) as { entryId?: unknown };
        if (typeof rec.entryId === "string") ids.add(rec.entryId);
      } catch {
        // 损坏行跳过（append-only 日志容错）
      }
    }
    return ids;
  }

  private deadLetterPath(): string {
    return join(this.dir, "deadletter.jsonl");
  }

  private atomicWriteJson(filePath: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, filePath);
  }

  /**
   * 库级 generation（快照标识/游标，不参与冲突判定）。
   * 文件缺失（初始）→ 0；文件损坏 → throw（游标不静默重置——base 漂移防护不变量）。
   */
  generation(): number {
    const p = this.generationPath();
    if (!existsSync(p)) return 0;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as { generation?: unknown };
      if (typeof raw.generation === "number") return raw.generation;
      throw new Error("missing generation field");
    } catch (err) {
      throw new Error(`generation.json corrupt: ${(err as Error).message}`);
    }
  }

  /**
   * 公域全部 official 条目（status === "official"；遍历 entries/ 经内部 MemoryStore，
   * 按 id 字典序稳定排序）。装配层只读访问器（plan Task 3 / spec §3.2 联合检索），
   * 返回快照——不持有锁（读路径无写者，单进程内同步串行）。
   */
  listOfficialEntries(): MemoryEntry[] {
    return this.store.retrieve({ status: ["official"] });
  }

  /**
   * fork：拷贝当前全部条目 → destDir（复用 MemoryStore 拷贝：读源全部条目逐条写入目标 store，
   * 索引重建）；返回当前 generation。fork 不递增 generation——generation 仅在成功 merge 后原子递增
   * （plan Step 3 / spec §2 不变量 3）。
   */
  fork(destDir: string): number {
    const dest = new MemoryStore(destDir);
    for (const entry of this.store.retrieve()) {
      dest.write(entry);
    }
    dest.rebuildIndex();
    return this.generation();
  }

  /**
   * submitWriteBack：锁内检查 base === generation → 逐 delta 查 id 冲突（entry-overlap）
   * → fast-forward 合入（delta 写入 + removeIds 删除）→ generation 原子递增。
   *
   * reason 语义：
   * - generation-stale：baseGeneration !== 当前 generation
   * - overlap：delta 中存在 id 已入库（钉死谓词：id 相同即冲突；anchors 重叠不冲突）
   * - conflict：removeIds 引用了库内不存在的 id（base 视图发散，无法 fast-forward 删除）
   */
  submitWriteBack(opts: SubmitWriteBackOpts): WriteBackResult {
    return this.withMergeLock(() => this.doSubmitWriteBack(opts));
  }

  private doSubmitWriteBack(opts: SubmitWriteBackOpts): WriteBackResult {
    const current = this.generation();
    if (opts.baseGeneration !== current) {
      return {
        ok: false,
        reason: "generation-stale",
        detail: `baseGeneration ${opts.baseGeneration} != current ${current}`,
      };
    }
    // 写校验链拒绝（spec §6）：delta 中任何条目带 meta.notWriteBack 或命中
    // dir/not-write-back.jsonl 标记（引用审核动作的条目不可回写）→ 拒绝合入
    const marked = this.notWriteBackIds();
    for (const entry of opts.delta) {
      if (entry.meta.notWriteBack === true || marked.has(entry.id)) {
        return {
          ok: false,
          reason: "not-write-back",
          detail: `delta id ${entry.id} 不可回写（引用审核动作的条目，not-write-back 标记）`,
        };
      }
    }
    for (const entry of opts.delta) {
      if (this.store.get(entry.id)) {
        return {
          ok: false,
          reason: "overlap",
          detail: `delta id ${entry.id} already in store (entry-overlap: id 相同即冲突)`,
        };
      }
    }
    for (const id of opts.removeIds ?? []) {
      if (!this.store.get(id)) {
        return {
          ok: false,
          reason: "conflict",
          detail: `removeIds ${id} not found in store (base 视图发散)`,
        };
      }
    }
    // fast-forward 合入：delta 写入（条目先、索引后——MemoryStore 写入顺序不变量）
    for (const entry of opts.delta) {
      this.store.write(entry);
    }
    // removeIds 删除：删条目文件 + 旁路计数器，索引经 rebuildIndex 重建（只走 MemoryStore 公共 API）
    if (opts.removeIds && opts.removeIds.length > 0) {
      for (const id of opts.removeIds) {
        rmSync(join(this.dir, "entries", `${id}.json`), { force: true });
        rmSync(join(this.dir, "counters", `${id}.json`), { force: true });
      }
      this.store.rebuildIndex();
    }
    // generation 原子递增（成功 merge 后；与检查同一临界区内）
    const next = current + 1;
    this.atomicWriteJson(this.generationPath(), { generation: next, updatedAt: Date.now() });
    return { ok: true, generation: next };
  }

  /**
   * merge 序列化（brief：mergeLock: boolean + 队列；v1 单进程内同步锁）。
   * JS 单线程：临界区天然原子——锁显式声明单写者 merge 语义；重入请求
   * （merge 路径内再次 submitWriteBack，v1 不可达：merge 只调 store 方法，store 不回调）
   * 入队，当前 merge 结束后按 FIFO 排空。
   */
  private withMergeLock<T>(fn: () => T): T {
    if (this.mergeLock) {
      let out!: T;
      this.mergeQueue.push(() => {
        out = fn();
      });
      return out;
    }
    this.mergeLock = true;
    try {
      return fn();
    } finally {
      this.mergeLock = false;
      while (this.mergeQueue.length > 0) {
        const next = this.mergeQueue.shift()!;
        next();
      }
    }
  }

  /**
   * 死信区写入（调用方 push：提交方重试 ≤3 由调用方管，耗尽后调用本方法留痕）。
   * append-only JSONL（事件留痕；operator 经 deadLetter() 处置，不静默丢）。
   */
  addDeadLetter(record: { deltaId: string; reason: string; at?: number }): void {
    mkdirSync(this.dir, { recursive: true });
    const line = JSON.stringify({
      deltaId: record.deltaId,
      reason: record.reason,
      at: record.at ?? Date.now(),
    });
    appendFileSync(this.deadLetterPath(), `${line}\n`);
  }

  /** 死信区查询（解析 JSONL；损坏行跳过——与 store 索引损坏防御语义一致）。 */
  deadLetter(): DeadLetterRecord[] {
    const p = this.deadLetterPath();
    if (!existsSync(p)) return [];
    const out: DeadLetterRecord[] = [];
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as DeadLetterRecord;
        if (typeof rec.deltaId === "string" && typeof rec.reason === "string" && typeof rec.at === "number") {
          out.push(rec);
        }
      } catch {
        // 损坏行跳过（防御；数据不静默删除）
      }
    }
    return out;
  }
}
