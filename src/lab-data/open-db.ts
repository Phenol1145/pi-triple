/**
 * lab-data — 数据访问层
 *
 * 用 raw SQL + node:sqlite 直接查询 agent-lab 数据库。
 * 不 import extensions/ 下任何模块。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 打开 SQLite 数据库（read-write + 只发 SELECT）。
 * WAL 模式 + busy_timeout 支持多进程安全读。
 */
export function openDb(filePath: string): DatabaseSync {
  // 确保父目录存在（首次可能没有 agent-lab/ 目录）
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

/** 共享 telemetry DB 路径 */
export function sharedDbPath(): string {
  if (process.env.AGENT_LAB_DB_PATH) return process.env.AGENT_LAB_DB_PATH;
  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  return path.resolve(dataDir, "shared", "agent-lab", "agent-lab.db");
}

/** per-tenant DB 路径 */
export function localDbPath(tenantId: string): string {
  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  return path.resolve(dataDir, "pi-config", tenantId, "agent-lab", "agent-lab.db");
}
