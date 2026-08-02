import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";

function agentRecord(id: string, schedulerInstanceId: string): AgentInstanceRecord {
  return {
    id,
    schedulerInstanceId,
    definition: {
      standard: {
        name: "test-agent",
        capabilities: ["test"],
        executionKind: "workloop",
        labels: {},
      },
      workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
      custom: {},
    },
    model: `model-${id}`,
    sourceTemplateId: "tpl-1",
    sourceAgentId: undefined,
    cloneOperationId: undefined,
    createdAtRoundId: "",
    status: "ready",
    createdAt: 1000,
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  return { db, repo };
}

test("getAgent returns the agent record by id", () => {
  const { db, repo } = setup();
  repo.insertAgent(agentRecord("agent-1", "si-1"));
  const found = repo.getAgent("agent-1");
  assert.ok(found !== undefined);
  assert.equal(found.id, "agent-1");
  assert.equal(found.schedulerInstanceId, "si-1");
  assert.equal(found.model, "model-agent-1");
  assert.equal(found.sourceTemplateId, "tpl-1");
  assert.equal(found.createdAtRoundId, "");
  assert.equal(found.status, "ready");
  assert.equal(found.createdAt, 1000);
  assert.deepEqual(found.definition, agentRecord("agent-1", "si-1").definition);
  db.close();
});

test("getAgent returns undefined for unknown id", () => {
  const { db, repo } = setup();
  repo.insertAgent(agentRecord("agent-1", "si-1"));
  assert.equal(repo.getAgent("agent-1-missing"), undefined);
  db.close();
});

test("getAgent single query by id, independent of scheduler_instance_id", () => {
  const { db, repo } = setup();
  repo.insertAgent(agentRecord("agent-1", "si-1"));
  repo.insertAgent(agentRecord("agent-2", "si-1"));
  repo.insertAgent(agentRecord("agent-3", "si-2"));
  // 按 id 单查：同一 scheduler 下多个 agent 不互相干扰
  assert.equal(repo.getAgent("agent-2")?.schedulerInstanceId, "si-1");
  assert.equal(repo.getAgent("agent-3")?.schedulerInstanceId, "si-2");
  assert.equal(repo.getAgent("agent-1")?.schedulerInstanceId, "si-1");
  // 既有方法不动：listAgents 仍按 scheduler_instance_id 全量返回
  assert.equal(repo.listAgents("si-1").length, 2);
  assert.equal(repo.listAgents("si-2").length, 1);
  db.close();
});
