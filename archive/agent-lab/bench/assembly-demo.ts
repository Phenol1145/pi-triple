// 装配层 bench 演示（plan Task 10 / spec §5.6）：
// 真实最小装配（pi-default-loop 定义 + json 方言 + endowment 100）+ 一轮 run 冒烟。
//
// 运行：node --experimental-strip-types bench/assembly-demo.ts
// 演示不做断言；打印装配产物摘要（agentId/余额/记忆域条目数/run 结果）。
//
// 说明：
// - runner 为 mock（返回伪结果）——pi-default-loop 真实 machine 的委托链需
//   pi-subagents 运行时（禁止运行 pit/pi 命令）；演示聚焦装配产物。
// - agentStore 为内存记录（N-I9 迁移未落地，repository 无扩展字段列——演示不涉持久层）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import type { AgentAssemblerDeps } from "../src/assembly/assembler.ts";
import { createAgentAssembler } from "../src/assembly/assembler.ts";
import type { AgentRuntime } from "../src/assembly/agent-runtime.ts";
import { MemoryHost } from "../src/assembly/memory-host.ts";
import type { AgentInstanceRecord, WorkLoopDefinition } from "../src/core/contracts.ts";
import type { WorkLoopResult } from "../src/workloop/contracts.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import { ASSEMBLY_DIR, PUBLIC_DOMAIN_DIR } from "../src/assembly/types.ts";

const WL_ID = "pi-default-loop";
const WL_VERSION = "1.0.0";
/** rule:fact 种子语法的合法内容。 */
const FACT_CONTENT = "sun | rises | east | 1.0";

/** pi-default-loop 的 WorkLoopDefinition（装配器消费面；machine 实现在 runner 侧）。 */
function piDefaultLoopDef(): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: WL_ID,
    version: WL_VERSION,
    sdkVersionRange: "^1.0.0",
    configSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        cwd: { type: "string" },
        contextMode: { type: "string", enum: ["fresh", "fork"] },
      },
      required: ["agent", "cwd", "contextMode"],
    },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "asm-demo-"));
  const db = new DatabaseSync(path.join(root, "ledger.db"));
  let runtime: AgentRuntime | undefined;
  try {
    // ── 真实最小装配 ─────────────────────────────────────────────
    const registry = new DefinitionRegistry();
    registry.register(piDefaultLoopDef());

    const ledger = new SqliteLedgerAdapter(new SqliteLedger(db)); // 真实 ledger（临时库）

    const pubDir = path.join(root, PUBLIC_DOMAIN_DIR);
    new PublicDomainBootstrap(pubDir).ensureInitialized(); // 真实公域种子
    const ruleBootstrap = new RuleBootstrap(pubDir);

    // runner mock（伪结果；真实 machine 执行留 D）
    let request: WorkLoopRunRequest | undefined;
    const runner = {
      run: async (req: WorkLoopRunRequest): Promise<WorkLoopResult> => {
        request = req;
        return {
          status: "completed",
          context: { messages: [], metadata: { contextId: "", sourceRefs: [], artifactRefs: [] } },
          state: {},
        };
      },
    } as unknown as AgentAssemblerDeps["runner"];

    const inserted: AgentInstanceRecord[] = [];
    const agentStore = {
      getAgent: (): AgentInstanceRecord | undefined => undefined,
      insertAgent: (r: AgentInstanceRecord): void => {
        inserted.push(r);
      },
    };

    const assembler = createAgentAssembler({
      registry,
      agentStore,
      ledger,
      ruleBootstrap,
      runner,
      workDir: root,
    });

    // 装配：pi-default-loop 定义 + json 方言 + endowment 100（spec §5.6）
    runtime = assembler.assembleAgent(
      { kind: "workloop", id: WL_ID, version: WL_VERSION },
      {
        cloneMode: "fresh",
        schedulerInstanceId: "demo-sched",
        endowment: { K: 100, initialFloor: 0.05 },
        memory: { dialect: "json" },
      },
    );

    // ── 一轮 run（mock runner 返回伪结果）────────────────────────
    const result = await runtime.run({ task: "装配演示冒烟" });

    // ── 记忆域：写一条私域条目 + 统计 ─────────────────────────────
    const agentDir = path.join(root, ASSEMBLY_DIR, runtime.agentId);
    const host = new MemoryHost({
      workDir: agentDir,
      pubDir,
      ruleBootstrap,
      spec: { dialect: "json" },
    });
    const w = host.pipeline.write({
      idempotencyKey: "demo-1",
      kind: "fact",
      anchors: ["demo"],
      content: FACT_CONTENT,
      ruleRef: "rule:fact",
    });
    const privateCount = host.store.listIds().length; // 私域条目数
    const jointCount = host.retrieve({}).length; // 联合检索（私域 + 公域 official）

    // ── 装配产物摘要 ──────────────────────────────────────────────
    console.log("── 装配演示摘要（agent-lab 装配层，Task 10）──");
    console.log(`agentId:         ${runtime.agentId}`);
    console.log(`注册:            ${inserted.length} 条（status=${inserted[0]?.status}, 哨兵 round=""）`);
    console.log(`开户余额:        ${ledger.balance(runtime.agentId)} K（endowment 100）`);
    console.log(`run 结果:        ${result.status}（workloop=${request?.workLoopId}@${request?.workLoopVersion}, agentInstanceId=${request?.agentInstanceId}）`);
    console.log(`记忆域条目数:    私域 ${privateCount}（含演示条目 ${w.ok ? 1 : 0}）/ 联合检索 ${jointCount}`);
    console.log(`规则链:          rule:fact 解析=${host.rules.resolveRule("rule:fact") !== undefined ? "ok（公域种子 fallback）" : "fail"}`);
    console.log(`记忆域目录:      ${agentDir}`);
  } finally {
    runtime?.dispose(); // 停 sweeper（interval 不 unref——必须清理）
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("assembly demo failed:", err);
  process.exitCode = 1;
});
