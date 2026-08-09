// 任务类型注册表（spec §4.1 / plan Task 5）——开放注册（重复 id 幂等 no-op）。
//
// 语义（spec §4.1）：TaskType = { id, description, baseDifficulty?, registeredBy, createdAt }；
// 开放注册 = 任意主体可注册新类型；重复 id 幂等（首次注册生效，后续调用 no-op——createdAt 不变，
// 不产生第二行）；类型注册 = elo 赛道自动创建（D2 消费方按 id 建赛道）；承接声明 AgentInstance.accepts
// 由 repository accepts 列承载（本任务 ④）。评审也是任务类型（D2 注册 "review"）。
//
// 持久化：自持 task_types 表（构造时 CREATE TABLE IF NOT EXISTS），与 SqliteVoucher 同模式
// （共享 DatabaseSync，模块自有表结构）。

import type { DatabaseSync } from "node:sqlite";

export type TaskType = {
  id: string;
  description: string;
  baseDifficulty?: "easy" | "medium" | "hard";
  registeredBy: string;
  createdAt: number;
};

export interface TaskTypeRegistry {
  register(t: TaskType): void;
  get(id: string): TaskType | undefined;
  list(): TaskType[];
}

const TASK_TYPES_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_types (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  base_difficulty TEXT,
  registered_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class SqliteTaskTypeRegistry implements TaskTypeRegistry {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(TASK_TYPES_SCHEMA);
  }

  /** 注册任务类型；重复 id 幂等 no-op（INSERT OR IGNORE——首次注册生效，createdAt 不变）。 */
  register(t: TaskType): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO task_types (id, description, base_difficulty, registered_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(t.id, t.description, t.baseDifficulty ?? null, t.registeredBy, t.createdAt);
  }

  /** 按 id 取回任务类型；未注册返回 undefined。 */
  get(id: string): TaskType | undefined {
    const row = this.db.prepare(
      `SELECT id, description, base_difficulty, registered_by, created_at
       FROM task_types WHERE id = ?`
    ).get(id) as {
      id: string; description: string; base_difficulty: string | null;
      registered_by: string; created_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      description: row.description,
      ...(row.base_difficulty !== null ? { baseDifficulty: row.base_difficulty as TaskType["baseDifficulty"] } : {}),
      registeredBy: row.registered_by,
      createdAt: row.created_at,
    };
  }

  /** 全量列出（注册顺序：created_at 升序，同刻按 id 字典序保证确定性）。 */
  list(): TaskType[] {
    const rows = this.db.prepare(
      `SELECT id, description, base_difficulty, registered_by, created_at
       FROM task_types ORDER BY created_at, id`
    ).all() as Array<{
      id: string; description: string; base_difficulty: string | null;
      registered_by: string; created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      ...(row.base_difficulty !== null ? { baseDifficulty: row.base_difficulty as TaskType["baseDifficulty"] } : {}),
      registeredBy: row.registered_by,
      createdAt: row.created_at,
    }));
  }
}
