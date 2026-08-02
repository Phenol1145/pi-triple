import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryStatus, MemoryEntry, MemoryKind } from "./entry.ts";

/**
 * contentHash：content 的 sha256 前 16 字符（确定性内容指纹）。
 */
function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * MemoryStore —— 记忆系统统一存储入口（spec §5）。
 *
 * 文件布局（spec §4）：
 *   dir/entries/<id>.json    每条目一文件（JSON）
 *   dir/index/anchors.json   { anchor: string[] } 锚点 → id 列表
 *   dir/counters/<id>.json   hitCount 旁路计数器（独立文件，不触发版本化）
 *
 * 原子写：<path>.tmp 写入后 renameSync（tmp+rename）。
 * 写入顺序：条目先、索引后 —— 崩溃窗口 = 索引落后（启动 rebuildIndex 修复）。
 * 并发控制：进程内同步串行（单写者队列语义）；CAS 由 update 读-改-写保证。
 */
export class MemoryStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private entriesDir(): string {
    return join(this.dir, "entries");
  }

  private entryPath(id: string): string {
    return join(this.entriesDir(), `${id}.json`);
  }

  private indexPath(): string {
    return join(this.dir, "index", "anchors.json");
  }

  private counterPath(id: string): string {
    return join(this.dir, "counters", `${id}.json`);
  }

  private atomicWrite(filePath: string, data: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, filePath);
  }

  private readJson<T>(filePath: string): T | undefined {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  }

  /** 索引缺失/损坏 → 视为空（rebuildIndex 修复；崩溃窗口语义）。 */
  private readIndex(): Record<string, string[]> {
    try {
      return this.readJson<Record<string, string[]>>(this.indexPath()) ?? {};
    } catch {
      return {};
    }
  }

  /** 条目先写、索引后写（写入顺序不变量）。 */
  private persist(entry: MemoryEntry): void {
    this.atomicWrite(this.entryPath(entry.id), entry);
    this.updateIndexFor(entry.id, entry.anchors ?? []);
  }

  private updateIndexFor(id: string, anchors: string[]): void {
    const index = this.readIndex();
    for (const key of Object.keys(index)) {
      const rest = index[key].filter((x) => x !== id);
      if (rest.length === 0) delete index[key];
      else index[key] = rest;
    }
    for (const a of anchors) {
      if (!index[a]) index[a] = [];
      if (!index[a].includes(id)) index[a].push(id);
    }
    this.atomicWrite(this.indexPath(), index);
  }

  /**
   * 幂等写（tmp+rename）：
   * - 同 id 不存在 → 直接落库；
   * - 同 id 已存在且版本/内容相同 → 重落库（watermark 旁路路径，Task 7 revive/recordVersion 用；不递增版本）；
   * - 同 id 已存在但为新状态 → 版本递增合并（version+1、updatedAt、versions[] 追加
   *   {version, watermark: 0, contentHash}——watermark 由 Task 7 填）。
   */
  write(entry: MemoryEntry): void {
    if (!entry.id) throw new Error("entry.id is required");
    const existing = this.get(entry.id);
    if (!existing) {
      this.persist(entry);
      return;
    }
    if (entry.meta?.version === existing.meta.version && entry.content === existing.content) {
      this.persist(entry);
      return;
    }
    const next = existing.meta.version + 1;
    const now = Date.now();
    this.persist({
      ...existing,
      ...entry,
      id: entry.id,
      anchors: entry.anchors ?? existing.anchors,
      meta: {
        ...existing.meta,
        ...(entry.meta ?? {}),
        version: next,
        updatedAt: now,
        hitCount: existing.meta.hitCount,
        versions: [
          ...(existing.meta.versions ?? []),
          { version: next, watermark: 0, contentHash: contentHash(entry.content) },
        ],
      },
    });
  }

  get(id: string): MemoryEntry | undefined {
    return this.readJson<MemoryEntry>(this.entryPath(id));
  }

  /** 版本递增 CAS：读-改-写；id 不存在 → throw（编程错误，不静默）。 */
  update(id: string, patch: Partial<MemoryEntry>): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`entry not found: ${id}`);
    const next = existing.meta.version + 1;
    const now = Date.now();
    const content = patch.content ?? existing.content;
    this.persist({
      ...existing,
      ...patch,
      id,
      anchors: patch.anchors ?? existing.anchors,
      meta: {
        ...existing.meta,
        ...(patch.meta ?? {}),
        version: next,
        updatedAt: now,
        hitCount: existing.meta.hitCount,
        versions: [
          ...(existing.meta.versions ?? []),
          { version: next, watermark: 0, contentHash: contentHash(content) },
        ],
      },
    });
  }

  /**
   * 检索（锚点精确匹配；多锚点 = 并集）。无 anchors → 全量；
   * kinds/status 过滤；excludeDrafts 排除 status === "draft"。
   * 返回按 id 字典序稳定排序（DSP 快照确定性）。
   */
  retrieve(opts: { anchors?: string[]; kinds?: MemoryKind[]; status?: EntryStatus[]; excludeDrafts?: boolean } = {}): MemoryEntry[] {
    let ids: string[];
    if (opts.anchors && opts.anchors.length > 0) {
      const index = this.readIndex();
      const set = new Set<string>();
      for (const a of opts.anchors) {
        for (const id of index[a] ?? []) set.add(id);
      }
      ids = [...set];
    } else {
      ids = this.listIds();
    }
    const out: MemoryEntry[] = [];
    for (const id of ids) {
      const e = this.get(id);
      if (!e) continue; // 索引可能落后于条目（崩溃窗口）→ 跳过；rebuildIndex 修复
      if (opts.kinds && !opts.kinds.includes(e.kind)) continue;
      if (opts.status && !opts.status.includes(e.status)) continue;
      if (opts.excludeDrafts && e.status === "draft") continue;
      out.push(e);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** 旁路计数器（独立文件）：不触发版本化、不参与 CAS；损坏 → 从 0 重计（崩溃回退可接受）。 */
  bumpHitCount(id: string): void {
    let count = 0;
    try {
      const raw = this.readJson<{ hitCount?: number }>(this.counterPath(id));
      if (raw && typeof raw.hitCount === "number") count = raw.hitCount;
    } catch {
      count = 0;
    }
    this.atomicWrite(this.counterPath(id), { id, hitCount: count + 1, updatedAt: Date.now() });
  }

  /** 启动时索引重建：扫描 entries/ 全量重建 anchors.json（修复崩溃窗口的索引落后）。 */
  rebuildIndex(): void {
    const index: Record<string, string[]> = {};
    const dir = this.entriesDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -".json".length);
        try {
          const entry = JSON.parse(readFileSync(join(dir, f), "utf-8")) as MemoryEntry;
          for (const a of entry.anchors ?? []) {
            if (!index[a]) index[a] = [];
            if (!index[a].includes(id)) index[a].push(id);
          }
        } catch {
          // 损坏条目文件跳过：索引可重建，条目文件保留不动（数据不静默删除）
        }
      }
    }
    this.atomicWrite(this.indexPath(), index);
  }

  listIds(): string[] {
    const dir = this.entriesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }
}
