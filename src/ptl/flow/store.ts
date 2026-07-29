/**
 * pit-flow store — run 目录 CRUD + 双锁 + checkpoint + 快照历史
 *
 * Run 目录:
 *   ~/.pi-triple/data/flows/<runId>/
 *   ├── graph.json / graph.history/ / state.json / checkpoints/
 *   ├── workspace/ / pending.json / lock / mutation.lock / meta.json
 *
 * 双锁模型:
 *   lock（执行锁）: 执行进程全程持有。O_EXCL 创建，pid+startTime 防复用。
 *     macOS stale 判定: process.kill(pid, 0) → ESRCH=死锁可回收；
 *     若 pid 存在则用 ps -p pid -o lstart= 比启动时间；
 *     不匹配 → pid 复用（死锁回收）；匹配 → 活锁抛错。
 *   mutation.lock（mutation 锁）: withMutationLock 短暂持有，
 *     覆盖 graph.json/state.json 的 RMW 窗口。
 *
 * 原子写: 所有 JSON 文件 writeFileSync(tmp) + renameSync(tmp, target)。
 * 纯读者（load*）不持锁，依赖 tmp+rename 原子性保证完整性。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { FlowDef } from "./schema.js";
import { interpolate } from "./template.js";

// ── Types ──────────────────────────────────────────────────────

export type RunStatus = "running" | "waiting_human" | "failed" | "done" | "editing";

export interface RunMeta {
  runId: string;
  name: string;
  status: RunStatus;
  createdAt: number;
  input: Record<string, string>;
  graphVersion: number;
  stepCount: number;
  firedEpoch?: Record<string, number>;   // v2: per-node completion count
  consumed?: Record<string, number>;       // v2: per-edge "pred→target" consumed count
  editRequested?: boolean;                 // v2: barrier
  editBaseWave?: number;                   // v2: wave where barrier triggered
  pendingEdits?: Array<{ path: string; value: unknown }>; // v2: queued edits
}

export interface Checkpoint {
  nodeId: string;
  graphVersion: number;
  seq: number;
  startedAt: number;
  finishedAt: number;
  status: "completed" | "failed";
  output: string;
  stateAfter: Record<string, unknown>;
}

export interface PendingPayload {
  nodeId: string;
  graphVersion: number;
  nodeSnapshot: Record<string, unknown>;
  message: string;
  createdAt: number;
}

/** v2: wave checkpoint */
export interface WaveCheckpoint {
  waveSeq: number;
  nodes: string[];
  startedAt: number;
  finishedAt: number;
  stateAfter: Record<string, unknown>;
  graphVersion: number;
  epochSnapshot: { fired: Record<string, number>; consumed: Record<string, number> };
  partialFailures: string[]; // nodeIds that failed in this wave
}

export interface RunSummary {
  runId: string;
  name: string;
  status: RunStatus;
  createdAt: number;
  stepCount: number;
}

export interface ExecLock {
  release(): void;
}

// ── pid/startTime helpers ──────────────────────────────────────

/** 获取当前进程启动时间字符串（ps lstart），用于锁内容比较 */
function getProcessStartTime(pid: number): string | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf-8",
    timeout: 2000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * 检查 pid 所代表的进程是否与 startTime 匹配。
 * - kill(pid,0) ESRCH → pid 不存在 → 死锁（可回收）
 * - pid 存在且 startTime 匹配 → 活锁
 * - pid 存在但 startTime 不匹配 → pid 复用（死锁可回收）
 * - 查询失败（权限/无 ps）→ 保守：视为活锁
 */
function isLockStale(pid: number, storedStartTime: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err.code === "ESRCH") return true; // pid 不存在
    return false; // EPERM 等：无法判断，保守视为活锁
  }

  // pid 存在，比较启动时间
  const actualStartTime = getProcessStartTime(pid);
  if (actualStartTime === null) {
    // ps 不可用，保守视为活锁
    return false;
  }
  return actualStartTime !== storedStartTime;
}

// ── Store ───────────────────────────────────────────────────────

export class FlowStore {
  private root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(
      process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple"),
      "data",
      "flows",
    );
  }

  // ── Run lifecycle ─────────────────────────────────────────

  hasRun(runId: string): boolean {
    return fs.existsSync(path.join(this.runDir(runId), "meta.json"));
  }

  createRun(def: FlowDef, input: Record<string, string>): string {
    const runId = randomUUID();
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });

    // 子目录
    fs.mkdirSync(path.join(dir, "checkpoints"));
    fs.mkdirSync(path.join(dir, "graph.history"));
    fs.mkdirSync(path.join(dir, "workspace"));
    fs.mkdirSync(path.join(dir, "waves"));   // v2: wave checkpoints

    // state 初始值：一次性插值
    const state: Record<string, unknown> = {};
    if (def.state) {
      for (const [k, v] of Object.entries(def.state)) {
        if (typeof v === "string") {
          state[k] = interpolateValue(v, input);
        } else {
          state[k] = v;
        }
      }
    }

    // 写文件
    const now = Date.now();
    this.writeAtomic(path.join(dir, "graph.json"), def);
    this.writeAtomic(path.join(dir, "state.json"), state);

    const meta: RunMeta = {
      runId,
      name: def.name,
      status: "running",
      createdAt: now,
      input,
      graphVersion: 1,
      stepCount: 0,
    };
    this.writeAtomic(path.join(dir, "meta.json"), meta);

    return runId;
  }

  removeRun(runId: string): boolean {
    const dir = this.runDir(runId);
    if (!fs.existsSync(dir)) return false;

    const meta = this.loadMeta(runId);
    if (!meta) return false;

    // 拒删 running/waiting/editing
    if (meta.status === "running" || meta.status === "waiting_human" || meta.status === "editing") {
      return false;
    }

    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // ── State ─────────────────────────────────────────────────

  loadState(runId: string): Record<string, unknown> {
    const p = path.join(this.runDir(runId), "state.json");
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  saveState(runId: string, state: Record<string, unknown>): void {
    const p = path.join(this.runDir(runId), "state.json");
    this.writeAtomic(p, state);
  }

  // ── Graph ─────────────────────────────────────────────────

  loadGraph(runId: string): FlowDef {
    const p = path.join(this.runDir(runId), "graph.json");
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  saveGraph(runId: string, def: FlowDef, version: number): void {
    const p = path.join(this.runDir(runId), "graph.json");
    this.writeAtomic(p, def);
    this.updateMeta(runId, { graphVersion: version });
  }

  /** 快照当前 graph.json → graph.history/v{N}.json，返回新版本号 */
  snapshotGraph(runId: string): number {
    const dir = this.runDir(runId);
    const currentVersion = this.loadMeta(runId).graphVersion;
    const newVersion = currentVersion + 1;

    // 读当前内容（纯读不持锁）
    const src = path.join(dir, "graph.json");
    const content = fs.readFileSync(src);

    // 写快照
    const histDir = path.join(dir, "graph.history");
    const snapshotPath = path.join(histDir, `v${newVersion}.json`);
    fs.writeFileSync(snapshotPath, content);

    // 更新 meta
    this.updateMeta(runId, { graphVersion: newVersion });

    return newVersion;
  }

  /** 列出 graph.history 目录中的版本快照 */
  listGraphHistory(runId: string): Array<{ version: number; createdAt: number }> {
    const dir = path.join(this.runDir(runId), "graph.history");
    if (!fs.existsSync(dir)) return [];
    const items: Array<{ version: number; createdAt: number }> = [];
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^v(\d+)\.json$/);
      if (m) {
        const stat = fs.statSync(path.join(dir, f));
        items.push({ version: parseInt(m[1]!, 10), createdAt: stat.mtimeMs });
      }
    }
    return items.sort((a, b) => a.version - b.version);
  }

  // ── Checkpoint ────────────────────────────────────────────

  writeCheckpoint(runId: string, cp: Checkpoint): void {
    const dir = path.join(this.runDir(runId), "checkpoints");
    const seq = cp.seq.toString().padStart(3, "0");
    const fileName = `${seq}-${cp.nodeId}.json`;
    const p = path.join(dir, fileName);
    this.writeAtomic(p, cp);
  }

  listCheckpoints(runId: string): Checkpoint[] {
    const dir = path.join(this.runDir(runId), "checkpoints");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Checkpoint);
  }

  latestCheckpoint(runId: string): Checkpoint | null {
    const list = this.listCheckpoints(runId);
    return list.length > 0 ? list[list.length - 1]! : null;
  }

  // ── Wave checkpoint (v2) ────────────────────────────────

  writeWaveCheckpoint(runId: string, wc: WaveCheckpoint): void {
    const dir = path.join(this.runDir(runId), "waves");
    const seq = wc.waveSeq.toString().padStart(3, "0");
    const p = path.join(dir, `${seq}.json`);
    this.writeAtomic(p, wc);
  }

  listWaveCheckpoints(runId: string): WaveCheckpoint[] {
    const dir = path.join(this.runDir(runId), "waves");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as WaveCheckpoint);
  }

  latestWaveCheckpoint(runId: string): WaveCheckpoint | null {
    const list = this.listWaveCheckpoints(runId);
    return list.length > 0 ? list[list.length - 1]! : null;
  }

  // ── Meta ──────────────────────────────────────────────────

  loadMeta(runId: string): RunMeta {
    const p = path.join(this.runDir(runId), "meta.json");
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  updateMeta(runId: string, patch: Partial<RunMeta>): void {
    const p = path.join(this.runDir(runId), "meta.json");
    const current = JSON.parse(fs.readFileSync(p, "utf-8")) as RunMeta;
    Object.assign(current, patch);
    this.writeAtomic(p, current);
  }

  // ── Pending ───────────────────────────────────────────────

  writePending(runId: string, payload: PendingPayload): void {
    const p = path.join(this.runDir(runId), "pending.json");
    this.writeAtomic(p, payload);
  }

  loadPending(runId: string): PendingPayload | null {
    const p = path.join(this.runDir(runId), "pending.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  clearPending(runId: string): void {
    const p = path.join(this.runDir(runId), "pending.json");
    try { fs.unlinkSync(p); } catch { /* 文件不存在，无操作 */ }
  }

  // ── Listing ───────────────────────────────────────────────

  listRuns(): RunSummary[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        try {
          const meta = JSON.parse(
            fs.readFileSync(path.join(this.root, e.name, "meta.json"), "utf-8"),
          ) as RunMeta;
          return {
            runId: meta.runId,
            name: meta.name,
            status: meta.status,
            createdAt: meta.createdAt,
            stepCount: meta.stepCount,
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is RunSummary => r !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Locks ─────────────────────────────────────────────────

  /**
   * 执行锁。O_EXCL 创建 lock 文件。
   * stale 判定: pid 不存在 OR 启动时间不匹配 → 死锁回收；活锁抛 Error。
   */
  acquireExecLock(runId: string): ExecLock {
    const lockPath = path.join(this.runDir(runId), "lock");
    const myPid = process.pid;
    const myStartTime = getProcessStartTime(myPid) ?? String(Date.now());

    // 尝试 O_EXCL 创建
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ pid: myPid, startTime: myStartTime, ts: Date.now() }),
          { flag: "wx" },
        );
        // 获取成功
        return {
          release: () => {
            try { fs.unlinkSync(lockPath); } catch { /* 文件已不存在 */ }
          },
        };
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        // 锁已存在，检查 stale
        const raw = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        const { pid, startTime } = raw as { pid: number; startTime: string };

        if (isLockStale(pid, startTime)) {
          // 死锁，回收
          try { fs.unlinkSync(lockPath); } catch { /* 竞争删除 */ }
          // 继续循环重试
          continue;
        }

        // 活锁 → 报错
        throw new Error(`Run ${runId} 正在被另一个进程执行（pid ${pid}）`);
      }
    }

    throw new Error(`无法获取执行锁: ${runId}（多次尝试后仍被占用）`);
  }

  /**
   * mutation 锁。短暂持有（RMW 窗口）。
   * withMutationLock(fn) 保证同一 run 的 graph/state RMW 串行化。
   */
  async withMutationLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.runDir(runId), "mutation.lock");

    // 忙等获取（mutation 锁持有者只持有 RMW 窗口毫秒级，不 sleep）
    for (let i = 0; i < 100; i++) {
      try {
        fs.writeFileSync(lockPath, "", { flag: "wx" });
        try {
          return await fn();
        } finally {
          try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
        }
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        // 被占用，稍等后重试
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    throw new Error(`无法获取 mutation 锁: ${runId}`);
  }

  // ── Helpers ────────────────────────────────────────────────

  runDir(runId: string): string {
    return path.join(this.root, runId);
  }

  /** 原子写：写 tmp 再 rename（JSON 内容换行结尾保证确定性） */
  private writeAtomic(filePath: string, data: unknown): void {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, filePath);
  }
}

/** 插值单个值（用于 state 初始值），不做 state 上下文替换（createRun 时 state 尚未填完） */
function interpolateValue(raw: string, input: Record<string, string>): string {
  return raw.replace(/\{\{input\.([^}]+)\}\}/g, (_match, key: string) => {
    return input[key.trim()] ?? "";
  });
}
