import type { ModelInfo } from "../types.ts";

export type AgentId = string;   // v1 = model id

export interface AgentState { agent: AgentId; model: ModelInfo; balance: number; }

export interface ArenaTask {
  id: string;
  role: string;
  prompt: string;
  difficulty: "easy" | "medium" | "hard" | number;
  odds: number;
  reward: number;
}

export interface Bid { agent: AgentId; stake: number; }
export interface ToolCallStat { name: string; durationMs: number; }

export interface Outcome {
  completion: number;
  majorError: boolean;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  toolCalls: ToolCallStat[];
  inferenceLatencyMs: number;
}

export interface CreditTx {
  id: number; ts: number; agent: AgentId; delta: number;
  reason?: string; taskId?: string; round?: number; agentTurn?: number;
}

export interface ModelCaller {
  complete(model: string, prompt: string, timeoutMs: number): Promise<string>;
}

export interface BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[];
}

export interface EndowmentPolicy { initialCredits(m: ModelInfo): number; }
export interface OddsPolicy { odds(t: ArenaTask): number; }
export interface BiddingPolicy { solicitBids(t: ArenaTask, c: AgentState[], caller?: ModelCaller): Promise<Bid[]>; }
export interface SettlementPolicy { settle(t: ArenaTask, stake: number, o: Outcome): number; }
export interface CostModel { usageCost(o: Outcome, m: ModelInfo): number; }
export interface Judge { score(t: ArenaTask, outputs: unknown[]): number[]; }   // 占位，Arena-8

export interface MarketTaskRow {
  taskId: string; role: string; prompt: string; difficulty: string;
  odds: number; reward: number; winner: string; stake: number; status: string; round: number;
}

export interface Ledger {
  balance(a: AgentId): number;
  ensureEndowed(a: AgentId, m: ModelInfo): void;
  credit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  debit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  freeze(a: AgentId, amt: number, taskId: string): boolean;
  unfreeze(a: AgentId, taskId: string): number;
  leaderboard(): { agent: AgentId; balance: number }[];
  history(a?: AgentId, limit?: number): CreditTx[];
  currentRound(): number;
  nextRound(): number;
  agentTurn(a: AgentId): number;
  createTask(t: ArenaTask, winner: AgentId, stake: number, round: number): void;
  getTask(taskId: string): MarketTaskRow | undefined;
  setTaskStatus(taskId: string, status: string): void;
  staleTasks(timeoutMs: number): MarketTaskRow[];
  recoverStaleTask(taskId: string): void;
}

export interface MarketAllocation { winner: AgentId; model: string; stake: number; taskId: string; round: number; }
export interface Market {
  allocate(t: ArenaTask, caller?: ModelCaller): Promise<MarketAllocation | undefined>;
  settle(taskId: string, o: Outcome): void;
}
