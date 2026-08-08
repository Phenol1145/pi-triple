/**
 * kernel-pool.ts — sandbox 侧共享 kernel 池（kernel sandbox SPEC §3.2）
 *
 * 职责：托管持久 PyKernel/BashKernel 进程，供多个 batch/worker 复用。
 *   - acquire：空闲优先（release 后复用同一 kernel——状态延续）；容量内新建；满则 FIFO 排队
 *   - execute/reset/snapshot：转发到池内 kernel（复用 PyKernel/BashKernel 实现）
 *   - release：归还池（唤醒排队者）
 *   - status：inFlight/idle/capacity 报告（监控/扩缩容信号）
 *
 * 安全边界：本池不注入任何业务密钥（协议层无 env 字段——敏感信息约束 §4.5）。
 */

import { PyKernel } from "../pth/kernel/interpreter/py-kernel.js";
import { BashKernel } from "../pth/kernel/interpreter/bash-kernel.js";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "../pth/kernel/interpreter/types.js";

export type KernelLang = "python" | "bash";

interface PoolEntry {
  id: string;
  kernel: Interpreter;
  inUse: boolean;
  lastUsedAt: number;
}

interface Waiter {
  resolve: (id: string) => void;
}

export interface KernelPoolOptions {
  lang: KernelLang;
  /** 池容量上限（默认 4） */
  max?: number;
  /** 空闲回收 ms（默认 0=宿主自行管理；>0 转给内核空闲回收） */
  idleMs?: number;
  onStderr?: (lang: string, line: string) => void;
}

export class KernelPool {
  readonly lang: KernelLang;
  private entries: PoolEntry[] = [];
  private waiters: Waiter[] = [];
  private counter = 0;
  private max: number;
  private idleMs: number;
  private onStderr?: (lang: string, line: string) => void;

  constructor(opts: KernelPoolOptions) {
    this.lang = opts.lang;
    this.max = opts.max ?? 4;
    this.idleMs = opts.idleMs ?? 0;
    this.onStderr = opts.onStderr;
  }

  private find(id: string): PoolEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.lang === "python" ? "py" : "sh"}-${this.counter}`;
  }

  private createKernel(): Interpreter {
    if (this.lang === "python") {
      return new PyKernel({ lazySpawn: true, resetMode: "ns", idleMs: this.idleMs, onStderr: (l) => this.onStderr?.(this.lang, l) });
    }
    return new BashKernel({ lazySpawn: true, idleMs: this.idleMs, onStderr: (l) => this.onStderr?.(this.lang, l) });
  }

  /** 获取一个 kernel（空闲优先；容量内新建；满则 FIFO 排队） */
  acquire(): Promise<string> {
    const idle = this.entries.find((e) => !e.inUse);
    if (idle) {
      idle.inUse = true;
      idle.lastUsedAt = Date.now();
      return Promise.resolve(idle.id);
    }
    if (this.entries.length < this.max) {
      const entry: PoolEntry = { id: this.nextId(), kernel: this.createKernel(), inUse: true, lastUsedAt: Date.now() };
      this.entries.push(entry);
      return Promise.resolve(entry.id);
    }
    return new Promise<string>((resolve) => this.waiters.push({ resolve }));
  }

  /** 归还 kernel（唤醒 FIFO 排队者） */
  release(id: string): void {
    const entry = this.find(id);
    if (!entry) return;
    entry.inUse = false;
    entry.lastUsedAt = Date.now();
    const waiter = this.waiters.shift();
    if (waiter) {
      entry.inUse = true;
      waiter.resolve(entry.id);
    }
  }

  async execute(id: string, code: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const entry = this.find(id);
    if (!entry) throw new Error(`unknown kernel: ${id}`);
    entry.lastUsedAt = Date.now();
    return entry.kernel.execute(code, opts);
  }

  async reset(id: string): Promise<void> {
    const entry = this.find(id);
    if (!entry) throw new Error(`unknown kernel: ${id}`);
    entry.kernel.reset();
  }

  async snapshot(id: string): Promise<InterpreterSnapshot> {
    const entry = this.find(id);
    if (!entry) throw new Error(`unknown kernel: ${id}`);
    return entry.kernel.snapshot();
  }

  status(): { lang: KernelLang; inFlight: number; idle: number; size: number; capacity: number } {
    return {
      lang: this.lang,
      inFlight: this.entries.filter((e) => e.inUse).length,
      idle: this.entries.filter((e) => !e.inUse).length,
      size: this.entries.length,
      capacity: this.max,
    };
  }

  /** 销毁全部 kernel（宿主关闭时） */
  async dispose(): Promise<void> {
    for (const e of this.entries) {
      try {
        e.kernel.dispose();
      } catch {
        /* 忽略单核销毁错误 */
      }
    }
    this.entries = [];
    this.waiters = [];
  }
}
