import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { createLabCore } from "../src/core/create-core.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import { ensureArenaInstance } from "../src/schedulers/bootstrap.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import type { ModelInfo } from "../src/types.ts";
import type { ModelCaller, EndowmentPolicy } from "../src/arena/types.ts";
import type { ArenaSchedulerPorts } from "../src/schedulers/arena-scheduler.ts";
import { runBench, codeGenPrompt, type BenchPorts } from "../src/bench/run.ts";
import type { HumanEvalTask } from "../src/bench/humaneval.ts";

const HE0: HumanEvalTask = {
  task_id: "HumanEval/0", entry_point: "has_close_elements",
  prompt: "from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    \"\"\"d\"\"\"\n",
  canonical_solution: "    return True\n",
  test: "def check(candidate):\n    assert candidate([1.0, 2.0, 3.9], 0.3) == True\n",
};

function model(id: string): ModelInfo {
  return { id, provider: id.split("/")[0], name: id, pricing: { in: 2, out: 6 }, perf: undefined, benchmarks: undefined, accessRoute: "direct" };
}
const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

// fake caller：bid 调用返回数字；code-gen 调用（含 codeGenPrompt 标记）返回指定代码
function fakeCaller(genCode: string, bids: string[] = []): ModelCaller & { bidCalls: number; genCalls: number } {
  const c = {
    bidCalls: 0, genCalls: 0,
    async complete(_model: string, prompt: string, _t: number) {
      if (prompt.includes("Complete the following Python function")) { c.genCalls++; return genCode; }
      c.bidCalls++;
      return bids.length ? (bids.shift() ?? "50") : "50";
    },
  };
  return c;
}

async function buildPorts(caller: ModelCaller) {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  const schedulers = new SchedulerRegistry(core.definitions);
  const ledger = new SqliteLedger(db, fixedEndow);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const arenaPorts: ArenaSchedulerPorts = { ledger, candidates: () => candidates, modelCaller: caller, resolveAgent: (m: ModelInfo) => `agent-${m.id}` };
  const result = await ensureArenaInstance(core, schedulers, arenaPorts, {
    instanceId: "default-arena",
    routingBindings: [{ id: "arena-default", priority: 10, match: {} }],
  });
  const runner = new SchedulerRunner({ core, schedulers });
  const benchPorts: BenchPorts = {
    dispatch: (req) => runner.dispatch(req),
    settle: (ref, o) => runner.settle(ref, o),
    balance: (a: string) => ledger.balance(a),
    getTask: (id: string) => ledger.getTask(id),
    candidates: () => candidates,
    eligibility: "all",
    matchEligibility: () => true,
    executeModel: (m: string, p: string) => caller.complete(m, p, 30000),
    genTimeoutMs: 30000, judgeTimeoutMs: 10000,
    schedulerInstanceId: result.instanceId,
  };
  return { benchPorts, ledger, candidates, caller };
}

test("闭环：pass 题走 arena 真实竞价，胜者余额净增（+2×stake）", async () => {
  const caller = fakeCaller(HE0.canonical_solution);  // 返回正确解 → pass
  const { benchPorts, ledger } = await buildPorts(caller);
  const report = await runBench(benchPorts, [HE0]);

  const r = report.results[0];
  assert.equal(r.status, undefined, "不应是 routing_fallback");
  assert.equal(r.settled, true);
  assert.equal(r.passed, true);
  assert.ok(caller.bidCalls > 0, "必须发生真实出价调用（BLOCKER-1 退化则 bidCalls=0）");

  // 找到胜者并用 ledger 查余额变化
  const winner = r.model!;
  const delta = ledger.balance(winner) - 1000;
  assert.ok(delta > 0, `pass 题胜者余额应净增，实际 delta=${delta}`);
});

test("闭环：fail 题胜者余额净减", async () => {
  const caller = fakeCaller("    return False\n");  // 错误解 → fail
  const { benchPorts, ledger } = await buildPorts(caller);
  const report = await runBench(benchPorts, [HE0]);
  const r = report.results[0];
  assert.equal(r.passed, false);
  assert.equal(r.settled, true);

  const winner = r.model!;
  const delta = ledger.balance(winner) - 1000;
  assert.ok(delta < 0, `fail 题胜者余额应净减，实际 delta=${delta}`);
});

test("codeGenPrompt 含可识别标记", () => {
  assert.ok(codeGenPrompt(HE0).includes("Complete the following Python function"));
  assert.ok(codeGenPrompt(HE0).includes(HE0.prompt));
});

// ── Error-path helpers & tests (fix round 1) ──────────────────────

function failingGenCaller(
  genCode: string,
): ModelCaller & { bidCalls: number; genCalls: number } {
  let genCount = 0, bidCount = 0;
  return {
    get bidCalls() { return bidCount; },
    get genCalls() { return genCount; },
    async complete(_model: string, prompt: string, _t: number) {
      if (prompt.includes("Complete the following Python function")) {
        genCount++;
        if (genCount === 1) throw new Error("model-unavailable");
        return genCode;
      }
      bidCount++;
      return "50";
    },
  };
}

test("I-1: routing_fallback — dispatch 返回 non-arena 结果时记录 status 且不结算", async () => {
  const stubs: BenchPorts = {
    dispatch: async () =>
      ({
        status: "abstained" as const,
        schedulerInstanceId: "default-weighted-scorer",
        roundId: "r",
        reason: "test",
        attempts: [],
      } as any),
    settle: async () => { throw new Error("should not be called"); },
    balance: () => 1000,
    getTask: () => undefined,
    candidates: () => [],
    eligibility: "all",
    matchEligibility: () => true,
    executeModel: async () => "",
    genTimeoutMs: 1000,
    judgeTimeoutMs: 1000,
    schedulerInstanceId: "default-arena",
  };
  const report = await runBench(stubs, [HE0]);
  const r = report.results[0];
  assert.equal(r.status, "routing_fallback");
  assert.equal(r.detail, "abstained");       // dispatch.status propagated
  assert.equal(r.settled, undefined);         // never reached settle
  assert.equal(r.model, undefined);           // never assigned
});

test("I-2: 批量 fail-open — 一题 executeModel 失败不阻断后续题", async () => {
  const caller = failingGenCaller(HE0.canonical_solution);
  const { benchPorts } = await buildPorts(caller);
  const HE1: HumanEvalTask = { ...HE0, task_id: "HumanEval/1" };

  const report = await runBench(benchPorts, [HE0, HE1]);
  assert.equal(report.results.length, 2, "两题都被处理，整批未中断");

  // 题 1：gen 抛错 → genError → passed=false → settled completion=0
  const r0 = report.results[0];
  assert.equal(r0.passed, false);
  assert.equal(r0.settled, true);
  assert.ok(r0.error, "应有 gen error");

  // 题 2：gen 正常 → judge pass → settled completion=1
  const r1 = report.results[1];
  assert.equal(r1.passed, true);
  assert.equal(r1.settled, true);
  assert.equal(r1.status, undefined, "不应是 routing_fallback");
});

test("I-3: executeModel 失败路径 — genError → settle(completion=0) → 胜者余额净减", async () => {
  const caller = failingGenCaller(HE0.canonical_solution);
  const { benchPorts, ledger } = await buildPorts(caller);

  const report = await runBench(benchPorts, [HE0]);
  const r = report.results[0];
  assert.equal(r.passed, false);
  assert.equal(r.settled, true);
  assert.ok(r.error, "应有 gen error");
  const delta = ledger.balance(r.model!) - 1000;
  assert.ok(delta < 0, `executeModel 失败应 settle(completion=0)，胜者余额净减，实际 delta=${delta}`);
});
