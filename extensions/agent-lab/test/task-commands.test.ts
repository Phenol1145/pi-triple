import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  renderTaskList, renderTaskPublish, renderTaskStatus, renderTaskRequeue, renderSelectorSet,
} from "../src/commands/render-task.ts";
import { registerCommands } from "../src/commands/register.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine } from "../src/taskpool/engine.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";
import type { LabConfig } from "../src/types.ts";

test("渲染函数：publish/list/status/requeue/selector", () => {
  const p = renderTaskPublish({ id: "t1", templateId: "semantic-split", labels: ["m"], createdAt: 1 });
  assert.ok(p.includes("t1"));
  assert.ok(p.includes("semantic-split"));
  const l = renderTaskList([{ id: "t1", status: "pending", templateId: "x" }]);
  assert.ok(l.includes("t1"));
  assert.ok(l.includes("pending"));
  const s = renderTaskStatus({ id: "t1", status: "claimed", claimedBy: "agent-a" });
  assert.ok(s.includes("agent-a"));
  const r = renderTaskRequeue({ id: "t1", status: "pending" });
  assert.ok(r.includes("t1"));
  const sel = renderSelectorSet("agent-a", { labelPatterns: ["^m$"] });
  assert.ok(sel.includes("agent-a"));
});

// ── 命令分发（裁决 I3 argv 下标：cmd=argv[0]，action=argv[1]，templateId/agentId=argv[2]） ──

interface NotifyCall { message: string; level: string }

function mockPi() {
  const notifies: NotifyCall[] = [];
  let handler:
    | ((
        args: string,
        ctx: { ui: { notify: (msg: string, level: string) => void } },
      ) => void | Promise<void>)
    | undefined;
  return {
    notifies,
    handler: () => handler!,
    pi: {
      registerCommand(_name: string, opts: { handler: typeof handler }) {
        handler = opts.handler;
      },
      registerTool(_opts: unknown) { /* no-op */ },
    },
    ctx() {
      return {
        ui: {
          notify(msg: string, level: string) {
            notifies.push({ message: msg, level });
          },
        },
      };
    },
  };
}

function defaultCfg(): LabConfig {
  return {
    weights: { completion: 1, costEffectiveness: 1, performance: 1, benchmark: 1 },
    autoApply: false,
    acceptanceScoreMap: {},
    interruptedPenalty: 0,
    toolFailPenalty: 0,
    topN: 5,
    catalogTtlMs: 60000,
    mode: "classic",
    market: {
      endowment: { K: 100, floor: 10 },
      odds: { easy: 1.5, medium: 2.0, hard: 2.5 },
      settlement: { tax: 0.1, errorMode: "stakeOnly" },
      cost: { tokenMult: 1, toolMult: 1, latencyMult: 1, resourceFactor: 1, toolWeights: {} },
      bidding: { timeoutMs: 5000, promptTemplate: "", maxCallsPerDispatch: 2 },
      market: { staleTaskTimeoutMs: 60000, eligibility: "all", maxBidders: 10, bidderSelector: "topBalance" },
      risk: { maxStakeRatio: 0.5 },
    },
  };
}

function placeholderDeps(overrides?: Record<string, unknown>) {
  return {
    store: { aggregateByRole: () => [], listRoles: () => [] } as unknown as Parameters<typeof registerCommands>[1]["store"],
    catalog: { candidates: () => [], refresh: async () => {}, isFresh: true } as unknown as Parameters<typeof registerCommands>[1]["catalog"],
    cfg: defaultCfg(),
    ledger: {
      leaderboard: () => [],
      staleTasks: () => [],
      getTask: () => undefined,
      recoverStaleTask: () => {},
      currentRound: () => 0,
    } as unknown as Parameters<typeof registerCommands>[1]["ledger"],
    saveConfig: (_c: LabConfig) => {},
    ...overrides,
  };
}

function freshTaskPool() {
  const dir = mkdtempSync(path.join(tmpdir(), "task-cmd-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  const repo = new CoreRepository(db);
  repo.insertAgent({
    id: "agent-a",
    schedulerInstanceId: "sched-1",
    definition: {
      standard: { name: "agent-a", capabilities: [], executionKind: "sync", labels: {} },
      workLoop: { id: "wl-1", version: "1", config: {} },
      custom: null,
    },
    createdAtRoundId: "round-1",
    status: "ready",
    createdAt: Date.now(),
  } satisfies AgentInstanceRecord);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const events: unknown[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  const engine = new SorterEngine(db, store);
  return { dir, db, registry, store, engine, taskPool: () => ({ registry, store, engine }) };
}

test("命令分发：/lab task publish/list/status/requeue + /lab agent selector（argv 下标 + 真实 taskPool）", async () => {
  const tp = freshTaskPool();
  const m = mockPi();
  registerCommands(m.pi, placeholderDeps({ taskPool: tp.taskPool }));
  const handler = m.handler();
  const find = (sub: string) => m.notifies.find((n) => n.message.includes(sub));
  const findIn = (ns: NotifyCall[], sub: string) => ns.find((n) => n.message.includes(sub));

  // taskPool 不可用（未注入）→ 友好错误
  const m2 = mockPi();
  registerCommands(m2.pi, placeholderDeps());
  await m2.handler()("task list", m2.ctx());
  assert.ok(findIn(m2.notifies, "Task pool unavailable"));

  // publish：--param k=v 填占位符、--label 进独立数组（不污染 params）
  await handler("task publish semantic-split --param relPath=docs/a.md --label urgent", m.ctx());
  const pub = find("任务已发布");
  assert.ok(pub, "publish 应有输出");
  assert.ok(pub!.message.includes("semantic-split"));
  assert.ok(pub!.message.includes("urgent"));
  const tasks = tp.store.list({});
  assert.equal(tasks.length, 1);
  const id = tasks[0]!.id;
  assert.equal(tasks[0]!.status, "pending");
  assert.ok(tasks[0]!.text.includes("docs/a.md")); // 模板占位符 <relPath> 已实例化
  assert.deepEqual(tasks[0]!.labels, ["memory-maintenance", "semantic-split", "urgent"]); // 模板标签 + --label

  // publish 缺 templateId → 用法错误
  m.notifies.length = 0;
  await handler("task publish", m.ctx());
  assert.ok(find("用法: /lab task publish <templateId>"));
  // publish 未知模板 → 错误可见
  m.notifies.length = 0;
  await handler("task publish nope", m.ctx());
  assert.ok(find("template not found: nope"));

  // list
  m.notifies.length = 0;
  await handler("task list", m.ctx());
  const lst = find(id);
  assert.ok(lst);
  assert.ok(lst!.message.includes("pending"));
  m.notifies.length = 0;
  await handler("task list --status pending", m.ctx());
  assert.ok(find(id));

  // 认领+拒绝后 status 展示认领/拒绝记录
  assert.equal(tp.store.claim("agent-a", id), "claimed");
  assert.equal(tp.store.reject("agent-a", id, "busy"), "rejected");
  m.notifies.length = 0;
  await handler(`task status ${id}`, m.ctx());
  const st = find(id);
  assert.ok(st!.message.includes("rejected"));
  assert.ok(st!.message.includes("agent-a(busy)"));
  // status 缺 id → 用法错误
  m.notifies.length = 0;
  await handler("task status", m.ctx());
  assert.ok(find("用法: /lab task status <id>"));

  // requeue：rejected → pending，计数/排除重置
  m.notifies.length = 0;
  await handler(`task requeue ${id}`, m.ctx());
  assert.ok(find("已重新入池"));
  const after = tp.store.get(id)!;
  assert.equal(after.status, "pending");
  assert.equal(after.claimsCount, 0);
  assert.deepEqual(after.rejects, []);
  m.notifies.length = 0;
  await handler(`task status ${id}`, m.ctx());
  assert.ok(find("认领次数: 0"));

  // agent selector：setSelector 持久化 + 渲染
  m.notifies.length = 0;
  await handler("agent selector agent-a --labels ^memory-maintenance$ --text semantic", m.ctx());
  assert.ok(find("agent-a"));
  assert.ok(find("已更新"));
  assert.deepEqual(tp.engine.getSelector("agent-a"), { labelPatterns: ["^memory-maintenance$"], textPattern: "semantic" });
  m.notifies.length = 0;
  await handler("agent selector", m.ctx());
  assert.ok(find("用法: /lab agent selector <agentId>"));

  tp.db.close();
  rmSync(tp.dir, { recursive: true, force: true });
});
