/**
 * arena-bid-loop@1.0.0 — 单一职责竞价 WorkLoop（状态转移函数 δ）。
 *
 * 经框架 ModelPort 调用候选模型询问出价，从响应解析 stake，checkpoint
 * 结果（持久化），返回 output.custom = { stake, reasoning }。不依赖
 * pi-subagents / place_bid 工具——出价来自模型响应（见 ADR-0001）。
 *
 * 由 Arena 调度器经 WorkLoopRunner 对每个候选施加（调度器级竞价 δ），
 * 获得 per-candidate single-flight + 遥测 + checkpoint。
 */
import { parseBidResponse } from "../arena/policies.ts";
import type {
  WorkLoopImplementation, WorkLoopInput, WorkLoopResult, WorkLoopSDK, WorkContext,
} from "../workloop/contracts.ts";

export interface ArenaBidLoopConfig {
  model?: string;
  promptTemplate?: string;
  balance?: number;
}

function buildBidContext(input: WorkLoopInput, config: ArenaBidLoopConfig): WorkContext {
  const contextId = `ctx-bid-${crypto.randomUUID()}`;
  return {
    systemPrompt: "你是一个竞价 agent。根据任务、赔率与你的余额，决定出多少 credits。只回一个数字（你的出价）。",
    messages: [{ role: "user", content: input.task }],
    metadata: { contextId, sourceRefs: [], artifactRefs: [] },
  };
}

export const arenaBidLoop: WorkLoopImplementation = {
  id: "arena-bid-loop",
  version: "1.0.0",
  cloneModes: ["fresh"],

  initialContext(_config: unknown): WorkContext {
    return { messages: [], metadata: { contextId: "ctx-initial", sourceRefs: [], artifactRefs: [] } };
  },

  initialState(_config: unknown): unknown {
    return {};
  },

  async run(input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> {
    const config = (input.config ?? {}) as ArenaBidLoopConfig;
    const balance = config.balance ?? Number.MAX_SAFE_INTEGER;
    const bidContext = buildBidContext(input, config);

    let reply: string;
    try {
      const res = await sdk.model.complete(bidContext, { model: config.model });
      reply = typeof res.message.content === "string" ? res.message.content : JSON.stringify(res.message.content);
      sdk.telemetry.emit("arena_bid.model_completed", { agent: input.agentInstanceId, model: config.model });
      const result: WorkLoopResult = {
        status: "completed",
        output: { standard: { text: reply, usage: res.usage } },
        context: bidContext,
        state: input.state,
      };
      const stake = parseBidResponse(reply, balance);
      result.output!.custom = { stake, reasoning: reply };
      // 持久化：checkpoint 出价结果（durable，可审计/恢复）
      await sdk.checkpoint.save(bidContext, { stake, reasoning: reply }, "bid-result");
      return result;
    } catch (err) {
      sdk.telemetry.emit("arena_bid.model_failed", { agent: input.agentInstanceId, model: config.model });
      return {
        status: "failed",
        error: { standard: { code: "bid-model-failed", message: err instanceof Error ? err.message : String(err), retryable: true } },
        context: bidContext,
        state: input.state,
      };
    }
  },
};