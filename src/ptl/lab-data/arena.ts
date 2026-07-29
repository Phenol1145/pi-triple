/**
 * lab-data/arena — per-template DB 查询（arena 经济模型）
 *
 * 表结构：
 *   credits (agent, balance, frozen, updated_ts)
 *   credit_tx (id, ts, agent, delta, reason, task_id, round, agent_turn)
 *   market_tasks (task_id, round, role, prompt, difficulty, odds, reward, winner, stake, status, created_ts)
 *   arena_freezes (task_id, agent, amount, created_ts)
 */

import type { DatabaseSync } from "node:sqlite";

export interface BalanceRow {
  agent: string;
  balance: number;
  frozen: number;
  wins: number;
  losses: number;
}

export function getBalances(db: DatabaseSync): BalanceRow[] {
  try {
    return db
      .prepare(
        `SELECT
          c.agent,
          c.balance,
          c.frozen,
          COALESCE(w.wins, 0) as wins,
          COALESCE(l.losses, 0) as losses
        FROM credits c
        LEFT JOIN (
          SELECT winner as agent, COUNT(*) as wins FROM market_tasks WHERE status = 'settled' GROUP BY winner
        ) w ON c.agent = w.agent
        LEFT JOIN (
          SELECT winner as agent, COUNT(*) as losses FROM market_tasks WHERE status = 'failed' GROUP BY winner
        ) l ON c.agent = l.agent
        ORDER BY c.balance DESC`,
      )
      .all() as unknown as BalanceRow[];
  } catch {
    return [];
  }
}

export interface SettlementRow {
  taskId: string;
  role: string;
  winner: string;
  stake: number;
  status: string;
  createdTs: number;
}

export function getRecentSettlements(db: DatabaseSync, limit = 20): SettlementRow[] {
  try {
    return db
      .prepare(
        `SELECT task_id as taskId, role, winner, stake, status, created_ts as createdTs
        FROM market_tasks
        ORDER BY created_ts DESC LIMIT ?`,
      )
      .all(limit) as unknown as SettlementRow[];
  } catch {
    return [];
  }
}

export interface FrozenRow {
  taskId: string;
  agent: string;
  amount: number;
  createdTs: number;
}

export function getFrozenTasks(db: DatabaseSync): FrozenRow[] {
  try {
    return db
      .prepare(
        `SELECT task_id as taskId, agent, amount, created_ts as createdTs
        FROM arena_freezes
        ORDER BY created_ts DESC LIMIT 50`,
      )
      .all() as unknown as FrozenRow[];
  } catch {
    return [];
  }
}
