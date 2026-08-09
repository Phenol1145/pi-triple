import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { createLabCore } from "../src/core/create-core.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import { ensureArenaInstance, ensureWeightedScorerInstance } from "../src/schedulers/bootstrap.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import type { ModelInfo } from "../src/types.ts";
import type { ModelCaller, EndowmentPolicy } from "../src/arena/types.ts";
import type { ArenaSchedulerPorts } from "../src/schedulers/arena-scheduler.ts";
import type { WeightedScorerPorts } from "../src/schedulers/weighted-scorer.ts";

function model(id: string): ModelInfo {
  return { id, provider: id.split("/")[0], name: id, pricing: { in: 2, out: 6 }, perf: undefined, benchmarks: undefined, accessRoute: "direct" };
}
const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
const caller: ModelCaller = { async complete() { return "50"; } };

// 回归：重启时 DB 实例已 active，但内存 SchedulerRegistry 是新建的。
// 旧代码幂等早返回跳过了实现注册 → 二次启动 "implementation not found"。
// 修复后：注册定义+实现在幂等检查之前，重启后实现仍在 fresh registry 中。
test("re-boot: ensureArenaInstance 二次调用（同 DB 新 registry）后实现仍注册，dispatch 不报 implementation not found", async () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ledger = new SqliteLedger(db, fixedEndow);
  const arenaPorts: ArenaSchedulerPorts = { ledger, candidates: () => candidates, modelCaller: caller, resolveAgent: (m: ModelInfo) => `agent-${m.id}` };

  // 第一次启动：创建实例
  const reg1 = new SchedulerRegistry(core.definitions);
  await ensureArenaInstance(core, reg1, arenaPorts, { instanceId: "default-arena", routingBindings: [{ id: "arena-default", priority: 10, match: {} }] });

  // 模拟重启：同 core/DB，全新 registry
  const reg2 = new SchedulerRegistry(core.definitions);
  const result2 = await ensureArenaInstance(core, reg2, arenaPorts, { instanceId: "default-arena", routingBindings: [{ id: "arena-default", priority: 10, match: {} }] });
  assert.equal(result2.instanceId, "default-arena");

  // 关键断言：用重启后的 registry 构造 runner，强制 dispatch 到 default-arena 不抛 "implementation not found"
  const runner = new SchedulerRunner({ core, schedulers: reg2 });
  const res = await runner.dispatch({ traceId: "reboot-test", schedulerInstanceId: "default-arena", role: "coder", task: "x", mode: "select", settlementRef: "reboot-test-ref" });
  // 不应是 "implementation not found" 类失败；completed 或正常 fallback 均可，但必须真正路由到 arena（completed + arena instance）
  assert.equal(res.status, "completed");
  assert.equal(res.schedulerInstanceId, "default-arena");
});

test("re-boot: ensureWeightedScorerInstance 二次调用后实现仍注册", async () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  const candidates = [model("google/gemini-pro"), model("meta/llama-3")];
  const wsPorts: WeightedScorerPorts = {
    candidates: () => candidates,
    aggregates: () => { const m = new Map(); for (const c of candidates) m.set(c.id, { completion: 0.8, costEffectiveness: 0.7, performance: 0.6, benchmark: 0.5 }); return m; },
    pinLookup: () => undefined,
  };

  const reg1 = new SchedulerRegistry(core.definitions);
  const r1 = await ensureWeightedScorerInstance(core, reg1, wsPorts, {});

  const reg2 = new SchedulerRegistry(core.definitions);
  const r2 = await ensureWeightedScorerInstance(core, reg2, wsPorts, {});
  assert.equal(r2.instanceId, r1.instanceId);

  const runner = new SchedulerRunner({ core, schedulers: reg2 });
  const res = await runner.dispatch({ traceId: "reboot-ws", schedulerInstanceId: r1.instanceId, role: "coder", task: "x", mode: "select" });
  assert.equal(res.status, "completed");
});
