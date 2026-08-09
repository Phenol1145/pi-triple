// elo 系统测试（plan Task 4 / spec §3）——公式注册表 + 默认公式 + 选择函数 + repository 列迁移。
// 7 场景：① taskRatingFromOdds 钉死（O=1→1500 / O=2→1700 / O=4→2100）；② simpleElo.initial=1500；
// ③ update 数值钉死（1516/1484）；④ FLOOR（R=100 不更低）；⑤ stakeEloPower 数值（含 elo=0 clamp）；
// ⑥ 注册表注册/未注册抛错/替换；⑦ repository elo 列 round-trip（eloGlobal + eloByDomain JSON map；
// 旧库 ALTER 迁移）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { CORE_SCHEMA } from "../src/core/storage/schema.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  createStakeEloPower,
  simpleElo,
  stakeEloPower,
  taskRatingFromOdds,
} from "../src/economy/elo.ts";
import type { EloFormula, SelectionFormula } from "../src/economy/elo.ts";

function agentRecord(id: string, over: Partial<AgentInstanceRecord> = {}): AgentInstanceRecord {
  return {
    id,
    schedulerInstanceId: "si-1",
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
    createdAtRoundId: "",
    status: "ready",
    createdAt: 1000,
    ...over,
  };
}

// ── ① taskRatingFromOdds 钉死 ─────────────────────────────────────
test("① taskRatingFromOdds 线性映射钉死：1500 + 200×(O−1)", () => {
  assert.equal(taskRatingFromOdds(1), 1500);
  assert.equal(taskRatingFromOdds(2), 1700);
  assert.equal(taskRatingFromOdds(4), 2100);
});

// ── ② simpleElo.initial = 1500 ────────────────────────────────────
test("② simpleElo.initial = 1500（组织与个人同分）", () => {
  assert.equal(simpleElo.initial({ isOrg: false }), 1500);
  assert.equal(simpleElo.initial({ isOrg: true }), 1500);
  assert.equal(simpleElo.id, "simple-elo");
});

// ── ③ update 数值钉死 ─────────────────────────────────────────────
test("③ simpleElo.update 数值钉死：1516 / 1484", () => {
  assert.equal(simpleElo.update(1500, { taskRating: 1500, outcome: 1 }), 1516);
  assert.equal(simpleElo.update(1500, { taskRating: 1500, outcome: 0 }), 1484);
});

// ── ④ FLOOR ───────────────────────────────────────────────────────
test("④ FLOOR：R=100 输大劣势局不更低（100）", () => {
  assert.equal(simpleElo.update(100, { taskRating: 2000, outcome: 0 }), 100);
});

// ── ⑤ stakeEloPower 数值 ──────────────────────────────────────────
test("⑤ stakeEloPower 数值：stake^1.0 × max(elo/1500, 0.01)^0.5", () => {
  assert.equal(stakeEloPower.id, "stake-elo-power");
  assert.equal(stakeEloPower.score({ stake: 10, elo: 1500 }, { taskRating: 1700 }), 10);
  // elo=0 → norm clamp 0.01 → 10 × sqrt(0.01) = 10 × 0.1 = 1
  assert.ok(Math.abs(stakeEloPower.score({ stake: 10, elo: 0 }, { taskRating: 1700 }) - 1) < 1e-9);
  // α/β 构造参数可覆盖：α=2, β=0.5 → 3^2 × 1^0.5 = 9
  const stronger = createStakeEloPower({ alpha: 2, beta: 0.5 });
  assert.equal(stronger.score({ stake: 3, elo: 1500 }, { taskRating: 1700 }), 9);
});

// ── ⑥ 注册表：注册/未注册抛错/替换 ────────────────────────────────
test("⑥ EloFormulaRegistry：注册/get/未注册抛错/同 id 替换", () => {
  const reg = new EloFormulaRegistry();
  reg.register(simpleElo);
  assert.equal(reg.get("simple-elo"), simpleElo);
  assert.throws(() => reg.get("missing"), /not registered/);
  // 同 id 再注册 = 替换（spec §12「公式注册替换」）
  const fake: EloFormula = { id: "simple-elo", initial: () => 100, update: (r) => r };
  reg.register(fake);
  assert.equal(reg.get("simple-elo"), fake);
});

test("⑥b SelectionFormulaRegistry：注册/get/未注册抛错/替换", () => {
  const reg = new SelectionFormulaRegistry();
  reg.register(stakeEloPower);
  assert.equal(reg.get("stake-elo-power"), stakeEloPower);
  assert.throws(() => reg.get("missing"), /not registered/);
  const fake: SelectionFormula = { id: "stake-elo-power", score: () => 42 };
  reg.register(fake);
  assert.equal(reg.get("stake-elo-power"), fake);
});

// ── ⑦ repository elo 列 round-trip ────────────────────────────────
test("⑦a insertAgent/getAgent round-trips eloGlobal + eloByDomain", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("agent-elo-1", {
    eloGlobal: 1640,
    eloByDomain: { market: 1516, review: 1490 },
  }));
  const got = repo.getAgent("agent-elo-1");
  assert.ok(got !== undefined);
  assert.equal(got.eloGlobal, 1640);
  assert.deepEqual(got.eloByDomain, { market: 1516, review: 1490 });
  db.close();
});

test("⑦b records without elo round-trip as undefined (backward compatible)", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("agent-elo-2"));
  const got = repo.getAgent("agent-elo-2");
  assert.ok(got !== undefined);
  assert.equal(got.eloGlobal, undefined);
  assert.equal(got.eloByDomain, undefined);
  db.close();
});

test("⑦c old-schema DB gets elo_global/elo_by_domain via ALTER migration, then round-trips", () => {
  const db = new DatabaseSync(":memory:");
  // 先跑当前 schema，再把 lab_agent_instances 替换成旧形状（无 elo 列）
  db.exec(CORE_SCHEMA);
  db.exec("DROP TABLE lab_agent_instances");
  db.exec(`CREATE TABLE lab_agent_instances (
    id TEXT PRIMARY KEY,
    scheduler_instance_id TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    model TEXT,
    source_template_id TEXT,
    source_agent_id TEXT,
    clone_operation_id TEXT,
    created_round_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_ts INTEGER NOT NULL
  )`);
  // CoreRepository 构造 = CORE_SCHEMA（IF NOT EXISTS no-op）+ _applyCoreMigrations（ALTER 补列）
  const repo = new CoreRepository(db);
  const cols = db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "elo_global"), "elo_global column added by migration");
  assert.ok(cols.some((c) => c.name === "elo_by_domain"), "elo_by_domain column added by migration");
  repo.insertAgent(agentRecord("agent-old-elo", {
    eloGlobal: 1500,
    eloByDomain: { math: 1600 },
  }));
  const got = repo.getAgent("agent-old-elo");
  assert.ok(got !== undefined);
  assert.equal(got.eloGlobal, 1500);
  assert.deepEqual(got.eloByDomain, { math: 1600 });
  db.close();
});
