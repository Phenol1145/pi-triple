import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { makeRunFlowV2, makeResumeFlowV2 } from "../../src/ptl/flow/engine.js";
import { FlowStore, readMetrics } from "../../src/ptl/flow/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── 竞价内核函数（test.* 命名空间，确定性，纯 mock 无真实 LLM/pi 调用）──────

beforeAll(() => {
  // 任务规范化：读 state.task
  registerCodeFn("test.preprocess", (_args, ctx) => ({ task: (ctx.state as any).task ?? "unknown" }));

  // 单个出价：args 从 state 取值（bidderN/stakeN/eloN），nodeId 决定取哪组键
  registerCodeFn("test.bid", (args, ctx) => {
    const idx = ctx.nodeId.replace("bid", ""); // bid1 → 1
    const a = args as any;
    return {
      bidder: a[`bidder${idx}`],
      stake: a[`stake${idx}`],
      elo: a[`elo${idx}`],
    };
  });

  // 评分选主：score = stake×1.0 + elo×1.0（权重简化），确定性排序取最高
  registerCodeFn("test.score", (args) => {
    const a = args as any;
    const raw = [a.b1, a.b2, a.b3].filter((x: unknown) => x != null);
    const bids: Array<{ bidder: string; stake: number; elo: number }> = raw.map((x: unknown) =>
      typeof x === "string" ? JSON.parse(x) : (x as { bidder: string; stake: number; elo: number }),
    );
    const scored = bids.map((b) => ({ ...b, score: b.stake + b.elo }));
    scored.sort((x, y) => y.score - x.score);
    return { winner: scored[0]!.bidder, winnerStake: scored[0]!.stake, scored };
  });

  // 结算：delta = round(stake × 0.9)
  registerCodeFn("test.settle", (args) => ({ delta: Math.round((args as any).winnerStake * 0.9) }));

  // 瞬时故障模拟：同一 run 首次调用抛错（→ failed），resume 重跑时成功（→ done）
  const flakyCalls = new Map<string, number>();
  registerCodeFn("test.flaky", (_args, ctx) => {
    const key = ctx.runId;
    const n = (flakyCalls.get(key) ?? 0) + 1;
    flakyCalls.set(key, n);
    if (n === 1) throw new Error("transient failure: bid node crashed");
    return { ok: true };
  });
});

// ── Bidding flow：并行出价 → AND-join 评分 → 确定性选主 → 结算 + metrics ──
// 出价输入预置在初始 state（bidderN/stakeN/eloN），score 的 args 从 state 取（b1/b2/b3）
const BIDDING_FLOW = {
  name: "bidding",
  entry: "pre",
  maxParallel: 4,
  state: {
    task: "T1",
    bids: [],
    winner: "",
    winnerStake: 0,
    delta: 0,
    // 预置竞价者输入（elo 相同，stake 不同 → winner 由最高分 stake+elo 决定）
    bidder1: "id1", stake1: 30, elo1: 10,
    bidder2: "id2", stake2: 50, elo2: 10,
    bidder3: "id3", stake3: 20, elo3: 10,
  },
  nodes: [
    { id: "pre", type: "code", fn: "test.preprocess", args: ["task"], writes: { task: "{{output.task}}" } },
    { id: "bid1", type: "code", fn: "test.bid", args: ["bidder1", "stake1", "elo1"], needs: ["pre"], writes: { b1: "{{output}}" } },
    { id: "bid2", type: "code", fn: "test.bid", args: ["bidder2", "stake2", "elo2"], needs: ["pre"], writes: { b2: "{{output}}" } },
    { id: "bid3", type: "code", fn: "test.bid", args: ["bidder3", "stake3", "elo3"], needs: ["pre"], writes: { b3: "{{output}}" } },
    { id: "score", type: "code", fn: "test.score", args: ["b1", "b2", "b3"], needs: ["bid1", "bid2", "bid3"],
      writes: { winner: "{{output.winner}}", winnerStake: "{{output.winnerStake}}" } },
    { id: "settle", type: "code", fn: "test.settle", args: ["winnerStake"], needs: ["score"],
      writes: { delta: "{{output.delta}}" },
      metrics: { credit: { from: "market", to: "{{state.winner}}", amount: "{{result.delta}}", reason: "settle" } } },
  ],
  edges: [
    { from: "pre", to: "bid1" }, { from: "pre", to: "bid2" }, { from: "pre", to: "bid3" },
    { from: "bid1", to: "score" }, { from: "bid2", to: "score" }, { from: "bid3", to: "score" },
    { from: "score", to: "settle" },
  ],
};

// 瞬时故障 flow：code 节点抛错 → failed → resume 重跑 → done
const FLAKY_FLOW = {
  name: "flaky",
  entry: "f",
  nodes: [{ id: "f", type: "code", fn: "test.flaky", writes: { out: "{{output.ok}}" } }],
  edges: [],
};

// mock spawnAgent：仅 agent 节点触发（本测试无 agent 节点，永不调用）
const mockSpawnAgent = async () => ({ exitCode: 0, output: "", signal: null });

async function runFlowV2(graph: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bid-"));
  const store = new FlowStore(dir);
  const runId = store.createRun(graph as any, {});
  const run = makeRunFlowV2(mockSpawnAgent);
  const result = await run(store, runId);
  return { result, store, runId, dir };
}

describe("bidding workflow integration", () => {
  it("runs full bidding round: parallel bids → AND-join score → settle with metrics", async () => {
    const { result, store, runId, dir } = await runFlowV2(BIDDING_FLOW);
    try {
      expect(result.status).toBe("done");

      // 确定性选主：最高分 = stake + elo 最大者（id2: 50+10 > id1: 30+10 > id3: 20+10）
      const state = store.loadState(runId);
      expect(state.winner).toBe("id2");
      expect(state.winnerStake).toBe(50);
      expect(state.delta).toBe(45); // Math.round(50 × 0.9)

      // 并行出价结果不串扰：b1/b2/b3 各写各的
      expect(JSON.parse(state.b1 as string)).toEqual({ bidder: "id1", stake: 30, elo: 10 });
      expect(JSON.parse(state.b2 as string)).toEqual({ bidder: "id2", stake: 50, elo: 10 });
      expect(JSON.parse(state.b3 as string)).toEqual({ bidder: "id3", stake: 20, elo: 10 });

      // metrics 事件：仅 settle 声明 → 1 条，求值正确（state.winner / result.delta）
      const metrics = readMetrics(store, runId);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.nodeId).toBe("settle");
      expect(metrics[0]!.metrics).toEqual({
        credit: { from: "market", to: "id2", amount: "45", reason: "settle" },
      });
      expect(typeof metrics[0]!.seq).toBe("number");
      expect(metrics[0]!.graphVersion).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes bids in one parallel wave and scores only after AND-join", async () => {
    const { result, store, runId, dir } = await runFlowV2(BIDDING_FLOW);
    try {
      expect(result.status).toBe("done");
      // 波次结构：pre 单独一波 → 三个出价同一波并行 → score 在三个出价全部完成后才就绪 → settle
      const waves = store.listWaveCheckpoints(runId);
      expect(waves.map((w) => [...w.nodes].sort())).toEqual([
        ["pre"],
        ["bid1", "bid2", "bid3"],
        ["score"],
        ["settle"],
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic: same graph replayed produces identical final state", async () => {
    const a = await runFlowV2(BIDDING_FLOW);
    const b = await runFlowV2(BIDDING_FLOW);
    try {
      expect(a.result.status).toBe("done");
      expect(b.result.status).toBe("done");
      // 同输入重放 → 同输出（含 b1/b2/b3、winner、delta 全量一致）
      expect(a.store.loadState(a.runId)).toEqual(b.store.loadState(b.runId));
      // metrics 事件数一致（timestamp 不同，不比内容）
      expect(readMetrics(a.store, a.runId)).toHaveLength(readMetrics(b.store, b.runId).length);
    } finally {
      fs.rmSync(a.dir, { recursive: true, force: true });
      fs.rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it("recovers from a failed code node: failed → resume reruns node → done", async () => {
    const { result, store, runId, dir } = await runFlowV2(FLAKY_FLOW);
    try {
      // 首次运行：节点抛错 → flow failed
      expect(result.status).toBe("failed");

      // resume 重跑失败节点 → 成功 → done
      const resume = makeResumeFlowV2(mockSpawnAgent);
      const resumed = await resume(store, runId);
      expect(resumed.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ out: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
