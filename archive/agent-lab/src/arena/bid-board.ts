/**
 * BidBoard — 进程内竞价收集板（纯逻辑，无 pi 依赖）。
 *
 * Arena 为每个候选生成不可猜测 token，注册 token→agent；竞价 subagent
 * 通过 place_bid 工具（agent-lab-bidder 扩展）按 token 写价；arena run
 * 返回后按 token 收集。token 一次性（first-wins），防重复/跨候选伪造。
 *
 * getBidBoard() 用 globalThis + Symbol.for 背书单例，保证 agent-lab 与
 * agent-lab-bidder 两个扩展（同进程、可能不同 ESM 模块实例）共享同一实例。
 */

export interface BidEntry {
  agentId: string;
  stake: number;
  reasoning: string;
}

export class BidBoard {
  private readonly open = new Map<string, string>(); // token → agentId
  private readonly bids = new Map<string, BidEntry>(); // token → entry

  openToken(token: string, agentId: string): void {
    this.open.set(token, agentId);
  }

  place(
    token: string,
    stake: number,
    reasoning: string,
  ): { ok: boolean; reason?: string } {
    const agentId = this.open.get(token);
    if (agentId === undefined) return { ok: false, reason: "unknown-token" };
    if (this.bids.has(token)) return { ok: false, reason: "already-bid" };
    this.bids.set(token, { agentId, stake, reasoning });
    return { ok: true };
  }

  collect(token: string): BidEntry | undefined {
    return this.bids.get(token);
  }

  close(token: string): void {
    this.open.delete(token);
    this.bids.delete(token);
  }
}

const BID_BOARD_KEY = Symbol.for("agent-lab.bidBoard");

export function getBidBoard(): BidBoard {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BID_BOARD_KEY]) g[BID_BOARD_KEY] = new BidBoard();
  return g[BID_BOARD_KEY] as BidBoard;
}
