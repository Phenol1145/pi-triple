/**
 * Pi-Triple 共享会话注册表（@away_from/shared — 自 extensions/_shared 迁入；
 * pit-control 仍用 extensions/_shared 副本）
 *
 * 每个租户维护 registry.json，记录活跃会话的基本信息。
 * 供 /mail ps 快速列出同租户所有会话，不需要逐个读 state.json。
 *
 * 并发写入协议：tmp + rename 原子覆盖。冲突窗口极小（<10 并发），重试一次。
 */
import fs from "node:fs";
import path from "node:path";

export interface RegistryEntry {
  sessionId: string;
  tenantId: string;
  name: string;
  pid: number;
  startedAt: string;
}

export class Registry {
  private filePath: string;

  /**
   * @param mailboxRoot  DATA_DIR/mailbox/
   * @param tenantId     租户 ID
   */
  constructor(mailboxRoot: string, private tenantId: string) {
    this.filePath = path.join(mailboxRoot, tenantId, "registry.json");
    fs.mkdirSync(path.join(mailboxRoot, tenantId), { recursive: true });
  }

  /** 注册或更新一个会话条目（key = sessionId） */
  register(entry: RegistryEntry): void {
    const all = this.readAll();
    all[entry.sessionId] = entry;
    this.writeAll(all);
  }

  /** 注销一个会话 */
  unregister(sessionId: string): void {
    const all = this.readAll();
    delete all[sessionId];
    this.writeAll(all);
  }

  /** 列出所有注册的会话 */
  list(): RegistryEntry[] {
    return Object.values(this.readAll()).sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt),
    );
  }

  /** 查找单个会话 */
  get(sessionId: string): RegistryEntry | undefined {
    return this.readAll()[sessionId];
  }

  /**
   * 清理 stale 条目（心跳已过期的会话）。
   * 由 Presence.isOnline() 判断每个注册会话。
   *
   * @param getStatePath sessionId → state.json 绝对路径
   */
  async cleanupStale(getStatePath: (sesionId: string) => string): Promise<number> {
    const all = this.readAll();
    let removed = 0;

    for (const [sessionId] of Object.entries(all)) {
      const sp = getStatePath(sessionId);
      try {
        // 仅在 Presence 已经导入的情况下使用；如果尚未加载则跳过清理
        const { Presence } = await import("./presence.js");
        if (!Presence.isOnline(sp)) {
          delete all[sessionId];
          removed++;
        }
      } catch {
        // 无法判断，保留条目（心跳可能刚启动）
      }
    }

    if (removed > 0) {
      this.writeAll(all);
    }
    return removed;
  }

  // ── 内部 ──────────────────────────────────────────────────

  private readAll(): Record<string, RegistryEntry> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  /**
   * 原子写入：tmp → rename。
   * 并发冲突重试一次。
   */
  private writeAll(data: Record<string, RegistryEntry>): void {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));

    try {
      fs.renameSync(tmp, this.filePath);
    } catch (e: any) {
      // rename 失败通常是因为并发写入者先 rename 了同一目标
      // 此时 tmp 已孤立（无引用），重试一次：读-改-写
      if (e.code === "ENOENT" || e.code === "ESTALE") {
        try {
          // 清理可能残留的 tmp
          try { fs.unlinkSync(tmp); } catch { /* ok */ }
          const current = this.readAll();
          Object.assign(current, data);
          const retryTmp = `${this.filePath}.tmp-${process.pid}-r`;
          fs.writeFileSync(retryTmp, JSON.stringify(current, null, 2));
          fs.renameSync(retryTmp, this.filePath);
        } catch {
          // 放弃
        }
      }
    }
  }
}
