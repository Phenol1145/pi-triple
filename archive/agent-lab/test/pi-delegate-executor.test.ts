import { test } from "node:test";
import assert from "node:assert/strict";
import { PiDelegateExecutor, updateToEvent } from "../src/workloops/executors/pi-delegate-executor.ts";
import type { ExecutorContext } from "../src/workloop/machine.ts";
import type { WorkLoopInput, WorkLoopSDK } from "../src/workloop/contracts.ts";
import type {
  SubagentDelegationV2Request, SubagentDelegationV2Update, SubagentDelegationV2TerminalResponse,
} from "../src/runtime/delegation-v2.ts";
import { FakeAdapter } from "./test-utils/fake-pi-subagents-adapter.ts";

test("updateToEvent: 映射为 pi_update 事件（保留全量 payload）", () => {
  const update: SubagentDelegationV2Update = { currentTool: "read", toolCount: 2, tokens: 100 };
  const ev = updateToEvent(update);
  assert.equal(ev.type, "pi_update");
  assert.equal((ev.payload as SubagentDelegationV2Update).currentTool, "read");
});

test("PiDelegateExecutor: 事件流 = pi_update × N → pi_terminal", async () => {
  const adapter = new FakeAdapter() as never;
  const buildRequest = (_input: WorkLoopInput, _ectx: ExecutorContext): SubagentDelegationV2Request =>
    ({ version: "v2", requestId: "r1", ownerRunId: "o1", nodeId: "n1", agent: "x", task: "t", context: "fresh", cwd: "/tmp" }) as SubagentDelegationV2Request;

  const executor = new PiDelegateExecutor(adapter, buildRequest);
  const input = { task: "t" } as WorkLoopInput;
  const sdk = {} as WorkLoopSDK;
  const ectx: ExecutorContext = { deriveDsp: () => "dsp" };

  // 先启动迭代，再注入事件
  const iterator = executor.start(input, sdk, ectx)[Symbol.asyncIterator]();
  const events: string[] = [];
  const reader = (async () => {
    for await (const ev of executor.start(input, sdk, ectx)) events.push(ev.type);
  })();

  const fake = adapter as unknown as FakeAdapter;
  setTimeout(() => fake.pushUpdate({ currentTool: "read" }), 20);
  setTimeout(() => fake.pushUpdate({ currentTool: "edit" }), 40);
  setTimeout(() => fake.finish({ status: "completed", usage: { input: 10, output: 5 } } as SubagentDelegationV2TerminalResponse), 60);

  await reader;
  assert.deepEqual(events, ["pi_update", "pi_update", "pi_terminal"]);
  assert.equal((fake.requests[0] as { task: string }).task, "t");
});
