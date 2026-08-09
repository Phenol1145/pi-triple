// 真实 LLM 冒烟：1 任务市场闭环（spec §5.1 全图 + §12 端到端）。
//
// 运行（cwd = extensions/agent-lab）：
//   node --experimental-strip-types examples/market-smoke.ts        # 默认 mock——零额度闭环验证
//   SMOKE_LLM=1 node --experimental-strip-types examples/market-smoke.ts  # execute 真实 DeepSeek（1 次调用）
//
// 模式（裁决 2026-08-04）：
//   - SMOKE_LLM=1 → spawnExecutor 走真实 DeepSeek chat API（仅 execute 1 次真实调用——
//     "写一个两数之和函数"）；bid/review 为确定性规则桩（stake/score 固定——最小额度 + 闭环可复现）。
//   - 缺省（mock）→ spawnExecutor 返回确定性 mock 交付——零额度先验证装配与闭环。
//
// 独立脚本（非 node:test）：不进 test/*.test.ts 套件——避免 CI 误触真实 LLM 调用。
// 凭据（doctor.ts 契约 + pi auth.json 兜底——plan "modelRegistry.getApiKeyForProvider()"
// 在 agent-lab 侧不存在，见 Task 3 报告适配说明）：
//   1) env PI_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY
//   2) ~/.pi/agent/auth.json 的 deepseek.key（pi registry 的实际凭据存储）
//
// 闭环：announce → 2 bidder（规则桩 stake 15/8）→ select → execute（真实 LLM 或 mock）
//       → 3 reviewer（规则桩 score 0.8/0.85/0.9）→ consensus → settle → apply_settlement。
// 断言：任务 settled + 资金守恒（Σ余额不变）+ 事件链齐全 + 无残留冻结 + execute 恰 1 次。
// 退出码：全 PASS → 0；任一 FAIL / 真实调用异常 → 1。
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher } from "../src/economy/voucher-port.ts";
import { MarketStore, type MarketTask } from "../src/economy/market-store.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { SqliteOrgMembership } from "../src/economy/org.ts";
import { SqliteTaskTypeRegistry } from "../src/economy/task-types.ts";
import { EloFormulaRegistry, SelectionFormulaRegistry, simpleElo, stakeEloPower } from "../src/economy/elo.ts";
import { CalibrationPool } from "../src/economy/calibration.ts";
import { ensureCentralPool, CENTRAL_POOL_ID } from "../src/economy/central-pool.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { MarketRunner } from "../src/economy/market-runner.ts";
import { projectEconomy } from "../src/economy/projections.ts";

// ── 模式与常量 ───────────────────────────────────────────────────
const useLLM = process.env.SMOKE_LLM === "1";
const RATES = { llm: 2, time: 1, compute: 1 };
const fixedEndow = { initialCredits: () => 1000 };

// 账户布局：2 bidder（w1/w2）+ 3 reviewer（r1/r2/r3）+ 发布方 pub。
// operator 仅流标兜底出现（本冒烟不触发——3 评审全部激活），含入守恒口径。
const AGENTS = ["w1", "w2", "r1", "r2", "r3"];
const PUBLISHER = "pub";
const ACCOUNTS = [...AGENTS, PUBLISHER, CENTRAL_POOL_ID, "operator"];

const TASK_SPEC = {
  typeId: "code",
  publisherId: PUBLISHER,
  maxStake: 20,
  odds: 3,
  brief: "写一个两数之和函数（JavaScript）。只输出函数代码本身，不要解释。",
} as const;

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// ── 凭据解析（doctor.ts 契约：PI_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY；auth.json 兜底）──
async function getApiKey(): Promise<string | null> {
  for (const v of ["PI_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"]) {
    const k = process.env[v];
    if (k) return k;
  }
  try {
    const auth = JSON.parse(
      readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf-8")
    ) as Record<string, { type?: string; key?: string }>;
    const d = auth["deepseek"];
    if (d?.type === "api_key" && d.key) return d.key;
  } catch {
    /* 无文件/坏 JSON → 交给调用方报错 */
  }
  return null;
}

/** 真实 DeepSeek 执行者（SMOKE_LLM=1——仅 execute 走真实调用，最小额度）。 */
async function deepseekExecute(winnerId: string, task: MarketTask): Promise<{ output: string; majorError?: boolean }> {
  const key = await getApiKey();
  if (!key) {
    throw new Error(
      "SMOKE_LLM=1 但未找到 DeepSeek 凭据：export DEEPSEEK_API_KEY=sk-...（或 PI_DEEPSEEK_API_KEY / ~/.pi/agent/auth.json deepseek.key）"
    );
  }
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "你是市场任务的执行 agent。严格按任务要求输出交付物，不要额外解释。" },
        { role: "user", content: `任务 taskId=${task.taskId}，winner=${winnerId}，brief：${task.brief}` },
      ],
      temperature: 0,
      max_tokens: 300,
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new Error(`DeepSeek API ${res.status}: ${snippet}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const output = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!output) throw new Error("DeepSeek API 返回空交付物（choices[0].message.content 为空）");
  return { output };
}

// ── 装配（与 test/market-integration.test.ts mkEnv 同构——共享同一 DatabaseSync）──
function agentRecord(id: string, over: Partial<AgentInstanceRecord> = {}): AgentInstanceRecord {
  return {
    id,
    schedulerInstanceId: "si-smoke",
    definition: {
      standard: {
        name: "smoke-agent",
        capabilities: ["code"],
        executionKind: "workloop",
        labels: {},
      },
      workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
      custom: {},
    },
    createdAtRoundId: "r0",
    status: "ready",
    createdAt: 1000,
    ...over,
  };
}

interface Env {
  db: DatabaseSync;
  ledger: SqliteLedger;
  voucher: SqliteVoucher;
  store: MarketStore;
  events: EconomyEventBus;
  repo: CoreRepository;
  org: SqliteOrgMembership;
  taskTypes: SqliteTaskTypeRegistry;
  elo: EloFormulaRegistry;
  selection: SelectionFormulaRegistry;
  cal: CalibrationPool;
}

function mkEnv(): Env {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, fixedEndow);
  ensureCentralPool(ledger);
  const store = new MarketStore(db);
  const events = new EconomyEventBus(db);
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: RATES }, poolId: CENTRAL_POOL_ID, eventBus: events });
  const repo = new CoreRepository(db);
  const org = new SqliteOrgMembership(db);
  const taskTypes = new SqliteTaskTypeRegistry(db);
  taskTypes.register({ id: "code", description: "coding task", registeredBy: "smoke", createdAt: 1 });
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const selection = new SelectionFormulaRegistry();
  selection.register(stakeEloPower);
  const cal = new CalibrationPool();
  return { db, ledger, store, events, voucher, repo, org, taskTypes, elo, selection, cal };
}

function addAgent(h: Env, id: string, opts: { eloGlobal?: number; accepts?: string[]; balance?: number } = {}): void {
  const { eloGlobal = 1500, accepts = ["code"], balance = 0 } = opts;
  h.repo.insertAgent(agentRecord(id, { accepts, eloGlobal }));
  h.ledger.credit(id, balance, "endow");
}

function balanceSum(ledger: SqliteLedger, ids: string[]): number {
  return ids.reduce((s, id) => s + ledger.balance(id), 0);
}

function frozenOf(db: DatabaseSync, agent: string): number {
  const row = db.prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(agent) as { frozen: number } | undefined;
  return row?.frozen ?? 0;
}

// ── 主流程 ───────────────────────────────────────────────────────
async function main(): Promise<number> {
  console.log(`market-smoke: 1 任务市场闭环（mode=${useLLM ? "REAL-LLM (SMOKE_LLM=1)" : "mock（零额度）"}）`);
  if (useLLM) {
    const key = await getApiKey();
    console.log(`  凭据：${key ? "found（env 或 ~/.pi/agent/auth.json deepseek.key）" : "MISSING——见 runbook 前置"} → ${key ? "仅 execute 1 次真实调用" : "中止"}`);
    if (!key) return 1;
  }

  const h = mkEnv();
  try {
    for (const id of AGENTS) addAgent(h, id, { balance: 200 });
    addAgent(h, PUBLISHER, { balance: 1000, accepts: [] });

    const before = balanceSum(h.ledger, ACCOUNTS);
    console.log(`  初始余额 Σ=${before.toFixed(1)}（agents 200×5 + pub 1000）`);

    // 规则桩（确定性——最小额度 + 闭环可复现）：
    // bidder：w1→15 / w2→8（其余 0——不入场）；reviewer：r1→0.8 / r2→0.85 / r3→0.9
    const spawnBidder = async (agentId: string): Promise<{ stake: number }> => ({
      stake: ({ w1: 15, w2: 8 } as Record<string, number>)[agentId] ?? 0,
    });
    const spawnReviewer = async (reviewerId: string): Promise<{ score: number }> => ({
      // 规则桩：仅 r1/r2/r3 激活（w2 落标后仍在评审候选池——返回 NaN 不激活，保持 brief 的 3 评审）
      score: ({ r1: 0.8, r2: 0.85, r3: 0.9 } as Record<string, number>)[reviewerId] ?? Number.NaN,
    });
    let executorCalls = 0;
    let lastDeliverable = "";
    const spawnExecutor = async (winnerId: string, task: MarketTask): Promise<{ output: string; majorError?: boolean }> => {
      executorCalls++;
      const out = useLLM
        ? await deepseekExecute(winnerId, task)
        : { output: `mock-deliverable;task=${task.taskId};winner=${winnerId};brief=${task.brief}` };
      lastDeliverable = out.output; // 观测捕获（runner 不暴露 deliverable——见报告）
      return out;
    };

    const runner = new MarketRunner({
      store: h.store,
      ledger: h.ledger,
      voucher: h.voucher,
      events: h.events,
      elo: h.elo,
      selection: h.selection,
      taskTypes: h.taskTypes,
      calibrationRate: 0,
      rng: () => 0.99,
      calibration: h.cal,
      orgMembers: h.org,
      codes: { register: () => {} },
      effects: { register: () => {} },
      repository: h.repo,
      taxRate: 0.05,
      candidates: () => AGENTS,
      spawnBidder,
      spawnReviewer,
      spawnExecutor,
    });

    console.log(`  运行闭环：announce → 2 bidder → select → execute → 3 reviewer → consensus → settle → apply_settlement`);
    const res = await runner.runMarket(TASK_SPEC);
    const task = h.store.getTask(res.taskId)!;

    // ── 观测输出 ──
    console.log(`\n── 闭环结果 ──`);
    console.log(`  taskId=${res.taskId}  status=${res.status}  winner=${task.winnerId}  winnerStake=${task.winnerStake}`);
    console.log(`  execute 调用次数=${executorCalls}（预期 1）`);
    const dl = lastDeliverable.replace(/\s+/g, " ").trim();
    console.log(`  LLM 交付物摘要（前 200 字符）：${dl.slice(0, 200)}${dl.length > 200 ? " …" : ""}`);
    console.log(`  （deliverable 由 runner 内部消费——观测面：评审激活 3 人 + settle 正常 = 执行相位成功）`);

    const after = balanceSum(h.ledger, ACCOUNTS);
    console.log(`\n── 余额（before → after）──`);
    for (const id of ACCOUNTS) {
      console.log(`  ${id.padEnd(12)} ${h.ledger.balance(id).toFixed(1)}`);
    }
    console.log(`  Σ= ${after.toFixed(6)}  Δ=${(after - before).toFixed(6)}`);

    const events = h.events.drain();
    const kinds = events.map((e) => e.kind);
    console.log(`\n── 事件流（${events.length} 条）──`);
    const byKind = new Map<string, number>();
    for (const k of kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1);
    for (const [k, n] of [...byKind.entries()].sort()) console.log(`  ${k} ×${n}`);
    for (const e of events) {
      const d = e.data;
      switch (e.kind) {
        case "economy.escrow_freeze": console.log(`  · ${e.kind} amount=${d.amount}`); break;
        case "economy.escrow_adjust": console.log(`  · ${e.kind} from=${d.from} to=${d.to}`); break;
        case "economy.bid_freeze": console.log(`  · ${e.kind} bidder=${d.bidderId} stake=${d.stake}`); break;
        case "economy.bid_release": console.log(`  · ${e.kind} bidder=${d.bidderId}`); break;
        case "economy.settle": console.log(`  · ${e.kind} role=${d.role} agent=${d.agentId} settle=${d.settle} gross=${d.gross} tax=${d.tax} to=${d.to ?? "-"}`); break;
        case "economy.review_consensus": console.log(`  · ${e.kind} R=${d.R} reviews=${(d.reviews as unknown[]).length}`); break;
        default: break;
      }
    }

    const report = projectEconomy(h.events.replayAll());
    console.log(`\n── 投影报表（事件重放重建）──`);
    console.log(`  poolBalance=${report.poolBalance.toFixed(4)}  minted=${report.minted}  burned=${report.burned}`);
    console.log(`  voucherStock=${JSON.stringify(report.voucherStock)}  creditVelocity=${report.creditVelocity.toFixed(3)}`);
    console.log(`  eloDistribution=${JSON.stringify(report.eloDistribution.buckets)}`);
    console.log(`  reviewerAccuracy=${JSON.stringify(report.reviewerAccuracy)}`);

    // ── 断言 ──
    const requiredKinds = [
      "economy.escrow_freeze",
      "economy.bid_freeze",
      "economy.escrow_adjust",
      "economy.bid_release",
      "economy.review_consensus",
      "economy.settle",
      "economy.elo_update",
    ];
    const checks: Array<{ name: string; pass: boolean }> = [
      { name: `任务 settled（res=${res.status} / task=${task.status}）`, pass: res.status === "settled" && task.status === "settled" },
      { name: `中标者 w1（stake 15 最高）`, pass: task.winnerId === "w1" },
      { name: `execute 恰 1 次调用`, pass: executorCalls === 1 },
      { name: `资金守恒（Δ=${(after - before).toFixed(6)} ≈ 0）`, pass: Math.abs(after - before) < 1e-6 },
      { name: `事件链 ${requiredKinds.length} 类齐全`, pass: requiredKinds.every((k) => kinds.includes(k)) },
      { name: `bid_freeze ×2 / bid_release ×1（未中标 w2 解冻）`, pass: kinds.filter((k) => k === "economy.bid_freeze").length === 2 && kinds.filter((k) => k === "economy.bid_release").length === 1 },
      { name: `settle 事件 4 条（executor + 3 reviewer）`, pass: events.filter((e) => e.kind === "economy.settle").length === 4 },
      { name: `无残留冻结（全部账户 frozen=0）`, pass: ACCOUNTS.every((id) => frozenOf(h.db, id) === 0) },
    ];
    console.log(`\n── 断言 ──`);
    for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`);
    return checks.every((c) => c.pass) ? 0 : 1;
  } catch (err) {
    console.error(`\n[SMOKE-FAIL] ${err instanceof Error ? err.message : String(err)}`);
    if (useLLM) {
      console.error("[排查] SMOKE_LLM=1 失败：429=额度/限流；401/403=key 无效；ECONNREFUSED/ENOTFOUND=网络。详见 runbook docs/superpowers/runbooks/2026-08-04-market-smoke.md");
    }
    return 1;
  } finally {
    h.db.close();
  }
}

process.exitCode = await main();
