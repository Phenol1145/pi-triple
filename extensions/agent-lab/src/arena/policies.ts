import type { MarketConfig, ModelInfo } from "../types.ts";
import type { AgentState, ArenaTask, BidderSelector, CostModel, EndowmentPolicy, ModelCaller, OddsPolicy, Outcome, SettlementPolicy } from "./types.ts";
import { blendedPrice } from "../catalog/parse.ts";

export class EndowmentPolicyV1 implements EndowmentPolicy {
  private cfg: MarketConfig;
  constructor(cfg: MarketConfig) { this.cfg = cfg; }
  initialCredits(m: ModelInfo): number {
    const price = blendedPrice(m);
    return Math.round(this.cfg.endowment.K / Math.max(price, this.cfg.endowment.floor));
  }
}

export class OddsPolicyV1 implements OddsPolicy {
  private cfg: MarketConfig;
  constructor(cfg: MarketConfig) { this.cfg = cfg; }
  odds(t: ArenaTask): number {
    if (t.odds && t.odds > 0) return t.odds;
    if (t.difficulty === "easy") return this.cfg.odds.easy;
    if (t.difficulty === "hard") return this.cfg.odds.hard;
    return this.cfg.odds.medium;
  }
}

export class SettlementPolicyV1 implements SettlementPolicy {
  private cfg: MarketConfig;
  constructor(cfg: MarketConfig) { this.cfg = cfg; }
  settle(t: ArenaTask, stake: number, o: Outcome): number {
    const O = t.odds;
    // majorError 恒 -stake（spec §7/M-R4-3）：errorMode 字段已 @deprecated，值被忽略（钉死 stakeOnly）。
    if (o.majorError) return -stake;
    const c = Math.max(0, Math.min(1, o.completion));
    return stake * (O - 1) * (2 * c - 1);
  }
}

export class CostModelV1 implements CostModel {
  private cfg: MarketConfig;
  constructor(cfg: MarketConfig) { this.cfg = cfg; }
  usageCost(o: Outcome, m: ModelInfo): number {
    const priceIn = m.pricing?.in ?? 0;
    const priceOut = m.pricing?.out ?? 0;
    const tokenCost = ((o.tokensIn * priceIn + o.tokensOut * priceOut) / 1_000_000) * this.cfg.cost.tokenMult;
    let toolCost = 0;
    for (const tc of o.toolCalls) {
      const w = this.cfg.cost.toolWeights[tc.name] ?? 0.5;
      toolCost += w * (tc.durationMs / 1000) * this.cfg.cost.resourceFactor;
    }
    toolCost *= this.cfg.cost.toolMult;
    const inferenceCost = (o.inferenceLatencyMs / 1000) * this.cfg.cost.latencyMult;
    return tokenCost + toolCost + inferenceCost;
  }
}

export const DEFAULT_BID_PROMPT = "任务：{prompt}（角色 {role}），难度 {difficulty}，赔率 {odds}。你当前 credits：{balance}。可押不超过可用余额。你押多少 credits 接此任务？只回一个数字。";

export function renderBidPrompt(template: string, vars: { prompt: string; role: string; difficulty: string; odds: number; balance: number }): string {
  return template
    .replaceAll("{prompt}", vars.prompt)
    .replaceAll("{role}", vars.role)
    .replaceAll("{difficulty}", vars.difficulty)
    .replaceAll("{odds}", String(vars.odds))
    .replaceAll("{balance}", String(vars.balance));
}

export class TopBalanceSelector implements BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[] {
    return [...candidates].sort((a, b) => b.balance - a.balance).slice(0, Math.max(0, n));
  }
}

export class RandomSelector implements BidderSelector {
  select(candidates: AgentState[], n: number): AgentState[] {
    const arr = [...candidates];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, Math.max(0, n));
  }
}

export function parseBidResponse(reply: string, availableBalance: number): number {
  const match = reply.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, Math.max(0, availableBalance));
}
