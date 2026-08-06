import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStrategy } from "../src/scheduler/strategy.ts";

const baseCfg = { defaultStrategy: "market" as const, weightedRoles: [] as string[] };

test("显式 strategy 最高优先", () => {
  assert.equal(resolveStrategy({ strategy: "direct", role: "r", caller: "timed-trigger" }, baseCfg), "direct");
  assert.equal(resolveStrategy({ strategy: "weighted", role: "r" }, baseCfg), "weighted");
  assert.equal(resolveStrategy({ strategy: "market", role: "r" }, baseCfg), "market");
});

test("labels.strategy 次优先", () => {
  const r = resolveStrategy({ role: "r", labels: { strategy: "direct" } }, baseCfg);
  assert.equal(r, "direct");
});

test("timed-trigger caller 默认 weighted", () => {
  assert.equal(resolveStrategy({ role: "r", caller: "timed-trigger" }, baseCfg), "weighted");
});

test("weightedRoles 白名单命中 → weighted", () => {
  const cfg = { defaultStrategy: "market" as const, weightedRoles: ["research", "review"] };
  assert.equal(resolveStrategy({ role: "research" }, cfg), "weighted");
  assert.equal(resolveStrategy({ role: "coding" }, cfg), "market");
});

test("兜底 defaultStrategy（默认 market）", () => {
  assert.equal(resolveStrategy({ role: "r" }, baseCfg), "market");
  const weightedDefault = { defaultStrategy: "weighted" as const, weightedRoles: [] as string[] };
  assert.equal(resolveStrategy({ role: "r" }, weightedDefault), "weighted");
});

test("无效 strategy 值回退 defaultStrategy", () => {
  // @ts-expect-error 非法值类型测试
  const r = resolveStrategy({ strategy: "bogus", role: "r" }, baseCfg);
  assert.equal(r, "market");
});
