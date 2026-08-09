import { createHash } from "node:crypto";
import type { MemoryEntry } from "./entry.ts";
import type { MemoryStore } from "./store.ts";

/**
 * contentHash：与 store.ts 同款确定性内容指纹（sha256 前 16 字符）。
 */
function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * WatermarkManager —— 版本级水位线（spec §4.2）。
 *
 * watermark 赋值语义（钉死）：= 该转移完成时将保存的 checkpoint seq（调用方传入
 * nextCheckpointSeq；禁止取上一已完成 seq）。watermark 挂在版本上（meta.versions[]
 * 每版本记录落地 seq）。
 *
 * 屏蔽规则：遮蔽 watermark > S 的版本；可见版本 = watermark ≤ S 的最新版；所有版本
 * 均被屏蔽 → 条目标记 pending-activation（不可见但存在，δ 可显式激活）。
 *
 * 存储层操作：recordVersion/revive 只更新当前版本（meta.version 对应版本）的
 * watermark，经 store.write 同版本同内容重落库（版本号不变、内容不变、消费标记
 * 不重置——消费标记在 Task 6 幂等表，本模块不触碰）。
 *
 * 内容投影说明：versions[] 仅存 contentHash（无历史内容），历史版本内容无法从
 * 持久层重建——本管理器在 recordVersion/revive 时快照当前版本内容（会话内内存表），
 * visibleVersions 用快照做投影归因；无快照（如重启后）回退当前内容（best-effort）。
 * 注：DSP 快照（spec 裁决 A）恢复走快照不重检索，投影层仅为防御性/会话内用途。
 */
export class WatermarkManager {
  private store: MemoryStore;
  /** 会话内内容快照：entryId → (version → content)。 */
  private contents = new Map<string, Map<number, string>>();

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /** 当前版本落库时记录 watermark（versions[] 追加/更新当前版本条目，版本号不变）。 */
  recordVersion(id: string, checkpointSeq: number): void {
    this.stamp(this.mustGet(id), checkpointSeq);
  }

  /** 幂等命中屏蔽条目 → 同 key 重落库：更新当前版本 watermark（内容不变、不递增版本）。 */
  revive(id: string, checkpointSeq: number): void {
    this.stamp(this.mustGet(id), checkpointSeq);
  }

  /** resume 到 S：屏蔽 watermark > S 的版本，返回可见版本（= watermark ≤ S 的最新版）投影。 */
  visibleVersions(seq: number): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const id of this.store.listIds()) {
      const entry = this.store.get(id);
      if (!entry) continue; // 索引/列表可能含已删条目（防御）
      const versions = entry.meta.versions ?? [];
      let visible: { version: number; watermark: number } | undefined;
      for (const v of versions) {
        if (v.watermark <= seq && (!visible || v.version > visible.version)) visible = v;
      }
      if (!visible) {
        // 无版本记录（未盖章/遗留条目）：无 watermark > S 可遮蔽 → 当前内容可见。
        // 与 Task 5 惯例一致：watermark 0 = 未赋值，任何 S ≥ 0 下均可见。
        if (versions.length === 0) visible = { version: entry.meta.version, watermark: 0 };
        else continue; // 所有版本均被屏蔽 → 不进投影（由 isPendingActivation 判定）
      }
      const content = this.contents.get(entry.id)?.get(visible.version) ?? entry.content;
      out.push({ ...entry, content, meta: { ...entry.meta, version: visible.version } });
    }
    return out;
  }

  /** 所有版本均被屏蔽（无任何 watermark ≤ S 的版本）→ pending-activation。 */
  isPendingActivation(entry: MemoryEntry, seq: number): boolean {
    const versions = entry.meta.versions ?? [];
    return versions.length > 0 && versions.every((v) => v.watermark > seq);
  }

  private mustGet(id: string): MemoryEntry {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`entry not found: ${id}`); // 编程错误，不静默
    return entry;
  }

  /** 当前版本 watermark 追加/更新 + 内容快照 + 同版本同内容重落库。 */
  private stamp(entry: MemoryEntry, seq: number): void {
    const version = entry.meta.version;
    const versions = [...(entry.meta.versions ?? [])];
    const idx = versions.findIndex((v) => v.version === version);
    if (idx >= 0) versions[idx] = { ...versions[idx], watermark: seq };
    else versions.push({ version, watermark: seq, contentHash: contentHash(entry.content) });

    let byVersion = this.contents.get(entry.id);
    if (!byVersion) {
      byVersion = new Map();
      this.contents.set(entry.id, byVersion);
    }
    byVersion.set(version, entry.content);

    // 同版本同内容 → store.write 重落库路径（版本号不变、内容不变）
    this.store.write({ ...entry, meta: { ...entry.meta, versions } });
  }
}
