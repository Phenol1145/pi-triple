import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./entry.ts";
import type { MemoryStore } from "./store.ts";
import type { WatermarkManager } from "./watermark.ts";

/**
 * DSP 集成（spec §7 / 计划 Task 11）。
 *
 * DSP 三区（每轮引擎重建、不持久化、不参与分支）：
 *   投影区 → 工具列表区 → 记忆入口区
 *   - 投影区：控制状态投影 + 预算剩余 + 环境元数据（DspInput.state/env/budget）
 *   - 工具列表区：动态可用性声明；v1 预留为空字符串（工具描述在 SSP）
 *   - 记忆入口区：检索注入摘要（v1 单一入口）+ "可沉淀候选"提示位
 *
 * 截断（牺牲顺序，spec §7）：投影区 → 工具列表区 → 记忆入口区，
 * 记忆入口区内候选提示位最后截断（先砍检索摘要、保留候选；候选本身超限才截候选）。
 * 上限：实时 4KB / 恢复 16KB（可配置）。
 *
 * 快照（用户裁决 A，spec §7）：检索结果快照纳入 checkpoint——
 *   - snapshot(seq, mode)：以水位线可见版本投影（visibleVersions(seq)，快照在 S 时刻
 *     生成只含当时可见版本，spec §4.2）生成 {text, memoryVersion, atSeq}，落盘
 *     dir/dsp-snapshots/<seq>.json（tmp+rename 原子写）。
 *   - 内容寻址去重：memoryVersion = sha256(text) 前 16 字符——text 相同 → 版本号相同
 *     （复用语义）；目标 seq 文件已存在且 text 相同 → 不重写。
 *   - restore(snap)：直接返回快照文本，不重检索不计数（hitCount 不动；恢复期间计数
 *     漂移为 spec 文档化接受项）；并把快照记为最近快照，供 build(_, "restore") 使用。
 *   - build(input, "restore") 的记忆入口区取自最近快照文本（不重检索）；
 *     无快照（如首次启动）回退新鲜检索（防御性，文档化）。
 *
 * 计数说明：DspBuilder 自身不调用 bumpHitCount——"hitCount 以实时检索为准"，
 * 实时检索点（build realtime / snapshot 生成）由调用方显式计数；restore 路径
 * 不触碰 store（天然不计数）。
 *
 * 注：快照目录经 opts.dir 注入（store 不暴露其内部 dir，且本任务只允许改
 * dsp.ts 与测试两个文件）；未配置 dir 时快照仅会话内存态（不落盘）。
 */
export interface DspInput {
  state: unknown;                    // 控制状态（投影源）
  memory: unknown;                   // L2 数据域（v1 不投影，预留）
  env: Record<string, unknown>;      // 环境元数据（时间/cwd）
  budget: { used: number; max: number };  // token 预算
  candidates?: string[];             // 本轮可沉淀候选（转移结束钩子）
}

export interface DspSnapshot {
  text: string;            // 检索摘要文本
  memoryVersion: string;   // 记忆版本号（内容寻址：sha256(text) 前 16 字符）
  atSeq: number;           // 快照生成时刻的 checkpoint seq
}

const DEFAULT_REALTIME_BYTES = 4096;
const DEFAULT_RESTORE_BYTES = 16384;

export class DspBuilder {
  private store: MemoryStore;
  private watermark: WatermarkManager;
  private opts: { maxRealtimeBytes?: number; maxRestoreBytes?: number; dir?: string };
  /** 最近快照（build restore 模式 / restore() 时更新；无快照 → 防御性回退新鲜检索）。 */
  private lastSnap: DspSnapshot | undefined;

  constructor(
    store: MemoryStore,
    watermark: WatermarkManager,
    opts: { maxRealtimeBytes?: number; maxRestoreBytes?: number; dir?: string } = {},
  ) {
    this.store = store;
    this.watermark = watermark;
    this.opts = opts;
  }

  /**
   * 三区合成：投影区 → 工具列表区 → 记忆入口区。
   * 截断（牺牲顺序）：投影区最先牺牲（只拿剩余预算），工具列表区次之，
   * 记忆入口区最后（候选提示位最后截断）。输出总字节 ≤ 模式上限。
   */
  build(input: DspInput, mode: "realtime" | "restore"): string {
    const limit = this.limitFor(mode);
    const projFull = this.renderProjection(input);

    let summary: string;
    if (mode === "restore" && this.lastSnap) {
      summary = this.lastSnap.text; // 恢复用快照：不重检索不计数
    } else {
      // v1 简化检索源：全部官方条目（无锚点过滤；锚点过滤留后续优化）。
      // 摘要行含锚点（[api] rate=100），即"锚点命中检索注入"。
      summary = this.renderMemoryEntries(this.store.retrieve({ excludeDrafts: true }));
    }
    const candText = this.renderCandidates(input.candidates);

    const mem = this.truncateMemSection(summary, candText, limit);
    let rest = limit - Buffer.byteLength(mem, "utf8");
    const tools = this.truncateBytes("", rest); // v1 预留空区；截断为恒等
    rest -= Buffer.byteLength(tools, "utf8");
    const proj = this.truncateBytes(projFull, rest);
    return proj + tools + mem;
  }

  /**
   * 检索快照（内容寻址去重）：text 相同 → memoryVersion 相同（sha256(text)），
   * 复用即天然成立；目标 seq 文件已存在且 text 相同 → 不重写。
   * 检索源 = 水位线可见版本投影（visibleVersions(seq)）——快照在 S 时刻生成
   * 只含当时可见版本（spec §4.2 与 DSP 快照一致性钉死）。
   */
  snapshot(seq: number, mode: "realtime" | "restore"): DspSnapshot {
    const text = this.renderMemoryEntries(this.watermark.visibleVersions(seq));
    const snap: DspSnapshot = { text, memoryVersion: this.memoryVersion(text), atSeq: seq };
    this.persistSnapshot(seq, snap);
    this.lastSnap = snap;
    return snap;
  }

  /** 恢复用快照：直接返回快照文本（不重检索不计数）；并记为最近快照。 */
  restore(snap: DspSnapshot): string {
    this.lastSnap = snap;
    return snap.text;
  }

  private limitFor(mode: "realtime" | "restore"): number {
    if (mode === "realtime") return this.opts.maxRealtimeBytes ?? DEFAULT_REALTIME_BYTES;
    return this.opts.maxRestoreBytes ?? DEFAULT_RESTORE_BYTES;
  }

  // ---- 三区渲染 ----

  private renderProjection(input: DspInput): string {
    const used = typeof input.budget?.used === "number" ? input.budget.used : 0;
    const max = typeof input.budget?.max === "number" ? input.budget.max : 0;
    const remaining = Math.max(0, max - used);
    return [
      "## Projection",
      `state: ${JSON.stringify(input.state ?? null)}`,
      `budget: ${used}/${max} (remaining ${remaining})`,
      `env: ${JSON.stringify(input.env ?? {})}`,
    ].join("\n");
  }

  /** 记忆入口区检索摘要：每行 `- [锚点] 内容`（锚点即"命中注入"标记）。 */
  private renderMemoryEntries(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";
    return entries.map((e) => `- [${e.anchors.join(",")}] ${e.content}`).join("\n");
  }

  /** 候选提示位：独立小节，拼接在摘要之后（截断时最后牺牲）。 */
  private renderCandidates(candidates: string[] | undefined): string {
    if (!candidates || candidates.length === 0) return "";
    return `\n## Candidates\n${candidates.map((c) => `- ${c}`).join("\n")}`;
  }

  // ---- 截断（字节级，避免切断多字节字符） ----

  /** 按 UTF-8 字节预算保留字符串头部（逐字符累计，不切断多字节字符）。 */
  private truncateBytes(s: string, budget: number): string {
    if (budget <= 0 || s.length === 0) return "";
    if (Buffer.byteLength(s, "utf8") <= budget) return s;
    let out = "";
    let len = 0;
    for (const ch of s) {
      const b = Buffer.byteLength(ch, "utf8");
      if (len + b > budget) break;
      out += ch;
      len += b;
    }
    return out;
  }

  /**
   * 记忆入口区截断：头部恒保留（很小）；先砍检索摘要，候选提示位最后截断
   * （候选本身超限才截候选）。
   */
  private truncateMemSection(summary: string, candText: string, budget: number): string {
    const header = "## Memory Entry\n";
    const headerBytes = Buffer.byteLength(header, "utf8");
    if (headerBytes >= budget) return this.truncateBytes(header, budget);
    const rest = budget - headerBytes;
    const sumBytes = Buffer.byteLength(summary, "utf8");
    const candBytes = Buffer.byteLength(candText, "utf8");
    if (sumBytes + candBytes <= rest) return header + summary + candText;
    const restAfterCand = rest - candBytes;
    if (restAfterCand <= 0) return header + this.truncateBytes(candText, rest);
    return header + this.truncateBytes(summary, restAfterCand) + candText;
  }

  // ---- 快照 ----

  private memoryVersion(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  }

  private snapshotsDir(): string | undefined {
    if (!this.opts.dir) return undefined;
    return join(this.opts.dir, "dsp-snapshots");
  }

  /** 落盘 dir/dsp-snapshots/<seq>.json（tmp+rename 原子写）；内容寻址去重：同 text 不重写。 */
  private persistSnapshot(seq: number, snap: DspSnapshot): void {
    const dir = this.snapshotsDir();
    if (!dir) return; // 未配置 dir → 会话内存态快照（不落盘）
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${seq}.json`);
    if (existsSync(file)) {
      try {
        const existing = JSON.parse(readFileSync(file, "utf-8")) as DspSnapshot;
        if (existing.text === snap.text) return; // 复用：不重写
      } catch {
        // 损坏文件 → 覆盖重写
      }
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2));
    renameSync(tmp, file);
  }
}
