import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { findOrCreateAgentByModel } from "../src/arena/agent-id.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { ModelInfo } from "../src/types.ts";

function model(id: string): ModelInfo {
  return { id, provider: id.includes("/") ? id.split("/")[0] : "unknown", name: id, pricing: { in: 2, out: 6 }, perf: undefined, benchmarks: undefined, accessRoute: "direct" };
}

test("findOrCreateAgentByModel: 同 model 两次返回同 UUID（幂等）", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const m = model("openai/gpt-4o");
  const id1 = findOrCreateAgentByModel(core, "test-scheduler", m, "template-1");
  const id2 = findOrCreateAgentByModel(core, "test-scheduler", m, "template-1");
  assert.equal(id1, id2, "同 model 应返回同 UUID");
  assert.match(id1, /^[0-9a-f-]{36}$/, "应为 UUID 格式");
});

test("findOrCreateAgentByModel: 不同 model 不同 UUID", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const id1 = findOrCreateAgentByModel(core, "test-scheduler", model("openai/gpt-4o"), "t1");
  const id2 = findOrCreateAgentByModel(core, "test-scheduler", model("anthropic/claude-3"), "t1");
  assert.notEqual(id1, id2, "不同 model 应不同 UUID");
});

test("findOrCreateAgentByModel: 跨模板同 model 共存（联邦统一市场，阶段 3a）", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const m = model("openai/gpt-4o");
  const idA = findOrCreateAgentByModel(core, "test-scheduler", m, "template-A");
  const idB = findOrCreateAgentByModel(core, "test-scheduler", m, "template-B");
  assert.notEqual(idA, idB, "跨模板同 model 应共存为两个 agent");
  // 同模板同 model 幂等
  const idA2 = findOrCreateAgentByModel(core, "test-scheduler", m, "template-A");
  assert.equal(idA, idA2, "同模板同 model 应幂等");
  const agentA = core.repository.findAgentByModel("test-scheduler", m.id, "template-A");
  const agentB = core.repository.findAgentByModel("test-scheduler", m.id, "template-B");
  assert.equal(agentA!.sourceTemplateId, "template-A");
  assert.equal(agentB!.sourceTemplateId, "template-B");
});

test("findOrCreateAgentByModel: sourceTemplateId 记录", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const m = model("openai/gpt-4o");
  findOrCreateAgentByModel(core, "test-scheduler", m, "template-42");
  const agent = core.repository.findAgentByModel("test-scheduler", m.id, "template-42");
  assert.ok(agent, "agent 应存在");
  assert.equal(agent!.sourceTemplateId, "template-42");
});

test("modelToAgentCreateSpec 返回 UUID（非 derived）", async () => {
  const { modelToAgentCreateSpec } = await import("../src/schedulers/weighted-scorer.ts");
  const spec = modelToAgentCreateSpec(model("openai/gpt-4o"), "arena");
  assert.match(spec.id, /^[0-9a-f-]{36}$/, "id 应为 UUID 格式");
  assert.ok(!spec.id.startsWith("agent-"), "不应为 derived 格式开头");
});

test("ensureSessionAgent: model 无现有 agent 时用 pit UUID 创建 + sourceTemplateId", async () => {
  const { ensureSessionAgent } = await import("../src/arena/agent-id.ts");
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const pitUuid = "11111111-1111-1111-1111-111111111111";
  const id = ensureSessionAgent(core, pitUuid, "test-scheduler", model("openai/gpt-4o"), "template-7");
  assert.equal(id, pitUuid, "model 无现有 agent 应用 pit UUID");
  const agent = core.repository.findAgentByModel("test-scheduler", "openai/gpt-4o", "template-7");
  assert.ok(agent);
  assert.equal(agent!.id, pitUuid);
  assert.equal(agent!.sourceTemplateId, "template-7");
});

test("ensureSessionAgent: 同模板同 model 已有 agent 则复用（忽略 pit UUID）", async () => {
  const { ensureSessionAgent, findOrCreateAgentByModel } = await import("../src/arena/agent-id.ts");
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const m = model("openai/gpt-4o");
  const existingId = findOrCreateAgentByModel(core, "test-scheduler", m, "t1");  // bootstrap 建的
  const pitUuid = "22222222-2222-2222-2222-222222222222";
  const id = ensureSessionAgent(core, pitUuid, "test-scheduler", m, "t1");  // 同模板 t1
  assert.equal(id, existingId, "同模板同 model 应复用其 id（忽略 pit UUID）");
});
