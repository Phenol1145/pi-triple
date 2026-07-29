/**
 * lab-data — 数据访问层
 *
 * 用 raw SQL + node:sqlite 直接查询 agent-lab 数据库。
 * 不 import extensions/ 下任何模块。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { pitHome } from "../config.js";

/**
 * 打开 SQLite 数据库。先尝试只读模式，失败再 fallback 读写。
 * 如果文件不存在则跳过只读尝试直接创建（WAL + busy_timeout）。
 */
export function openDb(filePath: string): DatabaseSync {
  if (existsSync(filePath)) {
    try {
      return new DatabaseSync(filePath, { readOnly: true });
    } catch {
      // readOnly failed (e.g. WAL without -shm), fallback to read-write
    }
  }

  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

/**
 * 尝试只读打开，文件不存在或不可读时返回 null。
 * TUI 监控页面用这个，避免在共享层创建空 DB。
 */
export function openReadOnlyOrNull(filePath: string): DatabaseSync | null {
  if (!existsSync(filePath)) return null;
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
}

/** 共享 telemetry DB 路径 */
export function sharedDbPath(): string {
  if (process.env.AGENT_LAB_DB_PATH) return process.env.AGENT_LAB_DB_PATH;
  return path.join(pitHome(), "data", "shared", "agent-lab", "agent-lab.db");
}

/** per-tenant DB 路径 */
export function localDbPath(templateId: string): string {
  if (process.env.AGENT_LAB_CONFIG_DIR) return path.join(process.env.AGENT_LAB_CONFIG_DIR, "agent-lab.db");
  return path.join(pitHome(), "data", "pi-config", templateId, "agent-lab", "agent-lab.db");
}
