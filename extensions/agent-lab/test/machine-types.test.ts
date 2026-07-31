import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  MachineDefinition, MachineEvent, MachineState, StepResult, Executor, ExecutorContext,
} from "../src/workloop/machine.ts";

// 类型级 + 结构级验证：一个最小示例机器（Task 2 将驱动它）
const echoMachine: MachineDefinition = {
  states: [
    { id: "idle" },
    { id: "done", terminal: true },
  ],
  initial: "idle",
  transitions: (state, event) => {
    if (state === "idle" && event.type === "start") return "done";
    return undefined;
  },
  step: async (ctx, state, event, sdk) => {
    const stepResult: StepResult = {
      context: ctx,
      state,
      terminal: {
        status: "completed",
        context: ctx,
        state,
      },
    };
    return stepResult;
  },
};

test("machine: 状态枚举与初始状态", () => {
  assert.equal(echoMachine.initial, "idle");
  assert.deepEqual(echoMachine.states.map((s) => s.id), ["idle", "done"]);
  assert.equal(echoMachine.states[1].terminal, true);
});

test("machine: 转移表命中与未命中", () => {
  assert.equal(echoMachine.transitions("idle", { type: "start" }), "done");
  assert.equal(echoMachine.transitions("idle", { type: "unknown" }), undefined);
  assert.equal(echoMachine.transitions("done", { type: "start" }), undefined);
});

test("machine: Executor 接口结构（委托式事件源形态）", async () => {
  const executor: Executor = {
    async *start(_input, _sdk, _ectx) {
      yield { type: "pi_update", payload: { currentTool: "read" } } satisfies MachineEvent;
    },
    dispose() {},
  };
  const ectx: ExecutorContext = { deriveDsp: () => "投影测试" };
  const events: MachineEvent[] = [];
  for await (const ev of executor.start({} as never, {} as never, ectx)) events.push(ev);
  assert.equal(events[0].type, "pi_update");
});

test("machine: MachineState 投影声明可选", () => {
  const s: MachineState = { id: "bankrupt", projection: () => "你处于破产状态" };
  assert.equal(s.projection?.({} as never, {}), "你处于破产状态");
});
