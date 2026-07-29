import { randomUUID } from "node:crypto";
import type { DispatchRequest, DispatchResult } from "../scheduler/runner.ts";
import type { SettleOutcome } from "../scheduler/contracts.ts";
import type { MarketTaskRow } from "../arena/types.ts";
import { extractCode } from "./extract.ts";
import { judgePython } from "./judge.ts";
import type { HumanEvalTask } from "./humaneval.ts";
import {
  renderBenchReport,
  type BenchReport,
  type BenchTaskResult,
  type ModelStat,
  type BalanceDelta,
} from "./report.ts";

export interface BenchPorts {
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  settle(ref: string, outcome: SettleOutcome): Promise<boolean>;
  balance(agent: string): number;
  getTask(id: string): MarketTaskRow | undefined;
  candidates(): { id: string }[];
  eligibility: string;
  matchEligibility(pattern: string, id: string): boolean;
  executeModel(model: string, prompt: string): Promise<string>;
  genTimeoutMs: number;
  judgeTimeoutMs: number;
}

export function codeGenPrompt(task: HumanEvalTask): string {
  return `Complete the following Python function. Return ONLY the code, no explanation.\n\n${task.prompt}`;
}

export async function runBench(
  ports: BenchPorts,
  tasks: HumanEvalTask[],
): Promise<BenchReport> {
  const runId = `bench-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const eligible = ports
    .candidates()
    .filter((c) => ports.matchEligibility(ports.eligibility, c.id));
  const before = new Map(eligible.map((c) => [c.id, ports.balance(c.id)]));
  const results: BenchTaskResult[] = [];

  for (const task of tasks) {
    const settlementRef = `${runId}-${task.task_id.replace("/", "-")}`;

    // ── 1. dispatch (arena real bidding) ──
    let dispatch: DispatchResult;
    try {
      dispatch = await ports.dispatch({
        traceId: settlementRef,
        schedulerInstanceId: "default-arena",
        role: "coder",
        task: task.prompt,
        taskCategory: "humaneval",
        mode: "select",
        settlementRef,
      });
    } catch (e) {
      results.push({
        task_id: task.task_id,
        status: "routing_fallback",
        detail: (e as Error).message,
      });
      continue;
    }

    // ★ 三重成功判据（k3 BLOCKER-1/2）
    const routedToArena =
      dispatch.status === "completed" &&
      dispatch.schedulerInstanceId === "default-arena" &&
      dispatch.settlementRef != null;
    if (!routedToArena) {
      results.push({
        task_id: task.task_id,
        status: "routing_fallback",
        detail: dispatch.status,
      });
      continue;
    }

    const model = dispatch.model ?? dispatch.selectedAgentId ?? "?";
    const stake = ports.getTask(settlementRef)?.stake ?? 0;

    // ── 2. execute model (code generation) ──
    const genPrompt = codeGenPrompt(task);
    const t0 = Date.now();
    let raw = "";
    let code = "";
    let genError: string | undefined;
    try {
      raw = await ports.executeModel(model, genPrompt);
      code = extractCode(raw, task.entry_point);
      if (!code.trim()) genError = "extraction_empty";
    } catch (e) {
      genError = (e as Error).message;
    }
    const latencyMs = Date.now() - t0;

    // ── 3. judge ──
    const judged = genError
      ? { passed: false, error: genError }
      : await judgePython(
          task.prompt,
          code,
          task.test,
          task.entry_point,
          ports.judgeTimeoutMs,
        );

    // ── 4. settle (k3 HIGH-5: inferenceLatencyMs=0, majorError=false) ──
    const outcome: SettleOutcome = {
      completion: judged.passed ? 1 : 0,
      majorError: false,
      tokensIn: Math.ceil(genPrompt.length / 4),
      tokensOut: Math.ceil(raw.length / 4),
      cost: 0,
      toolCalls: [],
      inferenceLatencyMs: 0,
    };
    let settled = false;
    try {
      settled = await ports.settle(settlementRef, outcome);
    } catch {
      settled = false;
    }

    results.push({
      task_id: task.task_id,
      model,
      stake,
      passed: judged.passed,
      settled,
      latencyMs,
      error: judged.error,
    });
  }

  // ── model stats ──
  const byModel = new Map<string, ModelStat>();
  for (const r of results) {
    if (!r.model || r.status === "routing_fallback") continue;
    const s = byModel.get(r.model) ?? {
      model: r.model,
      wins: 0,
      passes: 0,
      passRate: 0,
      totalStake: 0,
    };
    s.wins++;
    s.totalStake += r.stake ?? 0;
    if (r.passed) s.passes++;
    byModel.set(r.model, s);
  }
  const modelStats = [...byModel.values()].map((s) => ({
    ...s,
    passRate: s.wins ? s.passes / s.wins : 0,
  }));

  // ── balance deltas (settlement vs opt-out tax separated) ──
  const balanceDeltas: BalanceDelta[] = eligible
    .map((c) => {
      const b = before.get(c.id) ?? 0;
      const a = ports.balance(c.id);
      const stat = byModel.get(c.id);
      let settlement = 0;
      if (stat) {
        const wins = results.filter((r) => r.model === c.id);
        for (const w of wins) {
          settlement += w.passed ? 2 * (w.stake ?? 0) : -2 * (w.stake ?? 0);
        }
      }
      return {
        model: c.id,
        before: b,
        after: a,
        settlement,
        tax: a - b - settlement,
      };
    })
    .filter((d) => d.before !== d.after || byModel.has(d.model));

  return { runId, results, modelStats, balanceDeltas };
}

export { renderBenchReport };
