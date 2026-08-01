/**
 * market-bid-loop@1.0.0 — 单一职责竞价 WorkLoop（状态转移函数 δ）。
 *
 * 经框架 ModelPort 调用候选模型询问出价，从响应解析 stake，结果作为
 * terminal（MachineRuntime 自动 checkpoint）。返回 output.custom =
 * { stake, reasoning }。不依赖 pi-subagents / place_bid 工具——出价
 * 来自模型响应（见 ADR-0001）。
 *
 * Task 4 迁移：`marketBidLoop` 常量 → `createMarketBidLoop(config)` 工厂。
 * config（model/promptTemplate/balance）由工厂参数传入（原 input.config
 * 改为工厂参数；调用方 arena-scheduler 在 Task 6 同步改
 * `marketBidLoop` → `createMarketBidLoop(...)`）。手动 checkpoint 移除——
 * MachineRuntime 已自动 checkpoint。
 *
 * 由 Arena 调度器经 WorkLoopRunner 对每个候选施加（调度器级竞价 δ），
 * 获得 per-candidate single-flight + 遥测 + checkpoint。
 */
import { parseBidResponse } from "../arena/policies.ts";
import type { MachineDefinition } from "../workloop/machine.ts";
import type {
  WorkLoopImplementation, WorkLoopResult, WorkContext,
} from "../workloop/contracts.ts";

export interface ArenaBidLoopConfig {
  model?: string;
  promptTemplate?: string;
  balance?: number;
}

/** 构造竞价上下文：task 来自初始事件 payload（不再来自 input）。 */
export function buildBidContext(task: string, config: ArenaBidLoopConfig): WorkContext {
  const contextId = `ctx-bid-${crypto.randomUUID()}`;
  const defaultPrompt = "你是一个竞价 agent。根据任务、赔率与你的余额，决定出多少 credits。只回一个数字（你的出价）。";
  return {
    systemPrompt: config.promptTemplate ?? defaultPrompt,
    messages: [{ role: "user", content: task }],
    metadata: { contextId, sourceRefs: [], artifactRefs: [] },
  };
}

function parseBidReply(reply: string, balance: number): { stake: number; reasoning: string } {
  return { stake: parseBidResponse(reply, balance), reasoning: reply };
}

/**
 * 创建 market-bid-loop@1.0.0 WorkLoopImplementation（单转移状态机 idle→done）。
 *
 * 单次转移：start → done；δ 在 start 事件上完成竞价并直接返回 terminal
 * （status completed + output.custom = { stake, reasoning }；模型失败 →
 * terminal failed, retryable）。
 */
export function createMarketBidLoop(config: ArenaBidLoopConfig = {}): WorkLoopImplementation {
  const balance = config.balance ?? Number.MAX_SAFE_INTEGER;

  return {
    id: "market-bid-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",

    initialContext(_config: unknown): WorkContext {
      return { messages: [], metadata: { contextId: "ctx-initial", sourceRefs: [], artifactRefs: [] } };
    },

    initialState(_config: unknown): unknown {
      return {};
    },

    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (state, event) =>
        state === "idle" && event.type === "start" ? "done" : undefined,
      step: async (ctx, state, event, sdk) => {
        // task 来自初始事件 payload（MachineRuntime 注入：{ type: "start", payload: { task, agentInstanceId } }）
        const payload = event.payload as { task?: string; agentInstanceId?: string } | undefined;
        const task = payload?.task ?? "竞价";
        // Task 6 carry-forward：恢复 pre-migration 的 telemetry agent 字段
        // （MachineRuntime start 事件 payload 携带 agentInstanceId）。
        const agentInstanceId = payload?.agentInstanceId ?? "";
        const bidContext = buildBidContext(task, config);

        let reply: string;
        try {
          const res = await sdk.model.complete(bidContext, { model: config.model });
          reply = typeof res.message.content === "string" ? res.message.content : JSON.stringify(res.message.content);
          sdk.telemetry.emit("arena_bid.model_completed", { agent: agentInstanceId, model: config.model });
          const { stake, reasoning } = parseBidReply(reply, balance);
          const result: WorkLoopResult = {
            status: "completed",
            output: { standard: { text: reply, usage: res.usage }, custom: { stake, reasoning } },
            context: bidContext,
            state,
          };
          return { context: bidContext, state, terminal: result };
        } catch (err) {
          sdk.telemetry.emit("arena_bid.model_failed", { agent: agentInstanceId, model: config.model });
          return {
            context: bidContext,
            state,
            terminal: {
              status: "failed",
              error: {
                standard: {
                  code: "bid-model-failed",
                  message: err instanceof Error ? err.message : String(err),
                  retryable: true,
                },
              },
              context: bidContext,
              state,
            },
          };
        }
      },
    } satisfies MachineDefinition,
  };
}
