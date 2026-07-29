import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createLabCore } from "../src/core/create-core.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import { migrateDerivedAgentIds } from "../src/schedulers/bootstrap.ts";
import type { ModelInfo } from "../src/types.ts";

function freshSetup() {
  const d = new DatabaseSync(":memory:");
  const core = createLabCore(d);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  return { core, rawDb: d };
}

function model(id: string): ModelInfo {
  return { id, provider: id.split("/")[0], name: id, pricing: { in: 2, out: 6 }, perf: undefined, benchmarks: undefined, accessRoute: "direct" };
}

test("derived→UUID 迁移：agent-* id → UUID + model 列", () => {
  const { core, rawDb } = freshSetup();

  // Manually insert a derived-id agent (simulating old bootstrap state)
  rawDb.prepare(`
    INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, model, source_template_id, created_round_id, status, created_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agent-arena-openai-gpt-4o",
    "default-arena",
    JSON.stringify({ standard: { name: "openai/gpt-4o" } }),
    null,
    null,
    "round-0",
    "ready",
    Date.now(),
  );

  const migrated = migrateDerivedAgentIds(core, "default-arena", rawDb);
  assert.equal(migrated, 1);

  // Verify: old id is gone, new UUID agent exists with model populated
  const agents = core.repository.listAgents("default-arena");
  assert.equal(agents.length, 1);
  const a = agents[0];
  assert.ok(!a.id.startsWith("agent-"), "id should be UUID, not derived: " + a.id);
  assert.ok(a.id.includes("-"), "UUID has dashes: " + a.id);
  assert.equal(a.model, "openai/gpt-4o");

  // Verify old derived id row is gone
  const old = rawDb.prepare("SELECT id FROM lab_agent_instances WHERE id = ?").get("agent-arena-openai-gpt-4o");
  assert.equal(old, undefined);
});

test("derived→UUID 迁移：幂等（再次迁移不变）", () => {
  const { core, rawDb } = freshSetup();

  for (const m of ["openai/gpt-4o", "anthropic/claude-3"]) {
    rawDb.prepare(`
      INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, model, source_template_id, created_round_id, status, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`agent-arena-${m.replace(/[^a-zA-Z0-9_-]/g, "-")}`, "default-arena",
      JSON.stringify({ standard: { name: m } }), null, null, "round-0", "ready", Date.now());
  }

  const m1 = migrateDerivedAgentIds(core, "default-arena", rawDb);
  assert.equal(m1, 2);

  const m2 = migrateDerivedAgentIds(core, "default-arena", rawDb);
  assert.equal(m2, 0);

  const agents = core.repository.listAgents("default-arena");
  assert.equal(agents.length, 2);
  for (const a of agents) {
    assert.ok(!a.id.startsWith("agent-"));
    assert.ok(a.model);
  }
});

test("derived→UUID 迁移：无 derived id 返回 0（已迁移/空表）", () => {
  const { core, rawDb } = freshSetup();
  const m = migrateDerivedAgentIds(core, "default-arena", rawDb);
  assert.equal(m, 0);
});

test("derived→UUID 迁移：已有 model 的跳过", () => {
  const { core, rawDb } = freshSetup();

  // An agent with a derived id but already has a model populated
  rawDb.prepare(`
    INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, model, source_template_id, created_round_id, status, created_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agent-arena-deepseek-chat", "default-arena",
    JSON.stringify({ standard: { name: "deepseek/deepseek-chat" } }),
    "deepseek/deepseek-chat",
    null, "round-0", "ready", Date.now(),
  );

  // Should skip: filter checks !a.model (model is already set)
  const m = migrateDerivedAgentIds(core, "default-arena", rawDb);
  assert.equal(m, 0);

  // Agent still there unchanged
  const agents = core.repository.listAgents("default-arena");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, "agent-arena-deepseek-chat");
});
