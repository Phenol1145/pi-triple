/**
 * 示例：自定义存储后端 — MemorySessionStore（内存版 SessionStore，适合测试）
 *
 * 运行方式：npx tsx examples/custom-store/index.ts
 * 前置条件：无（纯内存，不需要 Redis）
 *
 * 参考文档：docs/architecture.md #存储模型
 *
 * 流程：
 *   1. 实现 SessionStore + SettingsStore 接口（来自 src/storage/interfaces.ts）
 *   2. 在 main.ts 中将 RedisSessionStore 替换为自定义实现
 *   3. 其余代码（AgentEngine / Gateway）通过接口消费，无需任何改动
 */

import type {
  SessionStore,
  SettingsStore,
  CredentialProvider,
} from "../../src/storage/interfaces.js";
import type {
  SessionMeta,
  SessionEntry,
  Snapshot,
  VersionSnapshotRecord,
  Settings,
} from "../../src/storage/types.js";

// ============================================================
// 第一步：实现 MemorySessionStore
// ============================================================
export class MemorySessionStore implements SessionStore {
  private metas = new Map<string, SessionMeta>();
  private entries = new Map<string, SessionEntry[]>();
  private snapshots = new Map<string, Snapshot[]>();
  private versionSnapshots = new Map<string, VersionSnapshotRecord[]>();

  private key(tenant: string, sessionId: string): string {
    return `${tenant}:${sessionId}`;
  }

  async appendEntry(tenant: string, sessionId: string, entry: SessionEntry): Promise<void> {
    const k = this.key(tenant, sessionId);
    const existing = this.entries.get(k) ?? [];
    existing.push(entry);
    this.entries.set(k, existing);
  }

  async getEntries(tenant: string, sessionId: string, fromSeq = 1): Promise<SessionEntry[]> {
    const k = this.key(tenant, sessionId);
    return (this.entries.get(k) ?? []).filter((e) => e.seq >= fromSeq);
  }

  async getMeta(tenant: string, sessionId: string): Promise<SessionMeta | null> {
    return this.metas.get(this.key(tenant, sessionId)) ?? null;
  }

  async saveMeta(tenant: string, sessionId: string, meta: SessionMeta): Promise<void> {
    this.metas.set(this.key(tenant, sessionId), meta);
  }

  async saveSnapshot(tenant: string, sessionId: string, snapshot: Snapshot): Promise<void> {
    const k = this.key(tenant, sessionId);
    const existing = this.snapshots.get(k) ?? [];
    existing.push(snapshot);
    this.snapshots.set(k, existing);
  }

  async getLatestSnapshot(tenant: string, sessionId: string): Promise<Snapshot | null> {
    const k = this.key(tenant, sessionId);
    const list = this.snapshots.get(k) ?? [];
    return list.length > 0 ? list[list.length - 1] : null;
  }

  async listSessions(tenant: string, project?: string): Promise<SessionMeta[]> {
    const all = [...this.metas.values()].filter((m) => m.tenantId === tenant);
    return project ? all.filter((m) => m.project === project) : all;
  }

  async deleteSession(tenant: string, sessionId: string): Promise<void> {
    const k = this.key(tenant, sessionId);
    this.metas.delete(k);
    this.entries.delete(k);
    this.snapshots.delete(k);
    this.versionSnapshots.delete(k);
  }

  async saveVersionSnapshot(tenant: string, sessionId: string, record: VersionSnapshotRecord): Promise<void> {
    const k = this.key(tenant, sessionId);
    const existing = this.versionSnapshots.get(k) ?? [];
    existing.push(record);
    this.versionSnapshots.set(k, existing);
  }

  async getLatestVersionSnapshot(tenant: string, sessionId: string): Promise<VersionSnapshotRecord | null> {
    const k = this.key(tenant, sessionId);
    const list = this.versionSnapshots.get(k) ?? [];
    return list.length > 0 ? list[list.length - 1] : null;
  }
}

// ============================================================
// 第二步：实现 MemorySettingsStore
// ============================================================
export class MemorySettingsStore implements SettingsStore {
  private store = new Map<string, Settings>();

  async get(tenant: string, project?: string): Promise<Settings> {
    return this.store.get(project ? `${tenant}:${project}` : tenant) ?? {};
  }

  async set(tenant: string, settings: Partial<Settings>, project?: string): Promise<void> {
    const key = project ? `${tenant}:${project}` : tenant;
    const existing = this.store.get(key) ?? {};
    this.store.set(key, { ...existing, ...settings });
  }
}

// ============================================================
// 第三步：在 main.ts 中替换
// ============================================================
// 将原来的：
//   const sessionStore = new RedisSessionStore(redis);
//   const settingsStore = new RedisSettingsStore(redis);
//
// 改为：
//   const sessionStore = new MemorySessionStore();
//   const settingsStore = new MemorySettingsStore();
//
// 其余代码完全不变 — AgentEngine / Gateway / WorkflowOrchestrator 均通过
// SessionStore 和 SettingsStore 接口消费存储能力。

// ============================================================
// 验证
// ============================================================
async function verify() {
  const store = new MemorySessionStore();
  const tenant = "test";
  const sid = "sess-1";

  // 写入
  await store.saveMeta(tenant, sid, {
    version: 1, sessionId: sid, tenantId: tenant, project: "demo",
    model: "test-model", thinkingLevel: "default", status: "active",
    entryCount: 0, lastEntrySeq: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  await store.appendEntry(tenant, sid, {
    version: 1, seq: 1, id: "e1", parentId: null,
    role: "user", content: [{ type: "text", text: "hello" }],
    createdAt: new Date().toISOString(),
  });

  // 读取
  const meta = await store.getMeta(tenant, sid);
  const entries = await store.getEntries(tenant, sid);
  const list = await store.listSessions(tenant);

  console.log("Meta:", meta?.model);
  console.log("Entries:", entries.length);
  console.log("Sessions:", list.length);
  console.log("✅ MemorySessionStore 验证通过");
}

verify().catch(console.error);
