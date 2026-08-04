// AgentAssembler —— 装配层核心（plan Task 8 / spec §2.2 六步装配流程，顺序钉死）。
//
// 流程：
//   1. registry.resolve({kind:"workloop", id, version}) → 未注册抛错
//   2a. config 过 configSchema（协调者裁决：最小 JSON Schema 子集手工校验——validateAgainstSchema；
//       config 来源 = 解析定义携带的可选 config 字段（WorkLoopDefinition 类型无此字段，duck-typed；
//       AssembleOptions 亦无 config 输入——T1 冻结，定义级 config 为装配语境默认配置））
//   2b. agentStore.getAgent(agentId)（agentId = idGen 生成 UUID，供后续复用）→ 已注册抛错（幂等冲突）
//   2b′. RESERVED_IDS 黑名单校验（spec §2：池/校准执行者不经外部装配路径；早于开户/记忆域）
//   2c. validateMemorySpec(def.memory ?? opts.memory)（def.memory 同为 duck-typed 可选字段）
//   3. 记忆域初始化：
//      fresh → 空私域 + fallback=ruleBootstrap（MemoryHost 构造于 <root>/agents/<id>/）
//      fork → 源 agent 私域整库拷贝（<root>/agents/<src>/ 目录级 cpSync——MemoryHost 布局下
//             workDir 即私域根，无 memory/ 子目录，见报告适配说明；拷贝后 rebuildIndex +
//             MemoryHost 重建 RuleRegistry（新实例读新目录））
//   4. ledger.open(agentId, K) → {created}；!created → 续跑信号（注册预检已保证未注册 → 继续）
//   5. insertAgent(record{ id, schedulerInstanceId, definition, memorySpec, endowment,
//      status:"ready", createdAtRoundId: ROUND_SENTINEL })（memorySpec/endowment 为结构超集字段，
//      AgentInstanceRecord 类型未含——见报告适配说明）
//   6. new AgentRuntime(...)（attachSdk 延迟到首次 run，由 AgentRuntime 负责）
// 失败清理：步骤 3/4/5/6 任一失败 → rmSync 记忆域目录 + created===true 时 ledger.removeAccount
//   （C 接线包项 9：removeAccount 已提进 LedgerPort 接口——不再经 adapter impl 暗门；
//   attempt-local：仅本调用创建的账户）
//
// 对 brief deps 的增补（超集，均可选，报告说明）：
//   - idGen?: () => string —— agentId 生成器（brief 钉死"装配器生成 UUID"；测试注入确定性）
//   - checkpointStore?: CheckpointStore —— T7 ruling：无参 resume latest 需要真实 CheckpointStore
//   - bridge?: CommsBridge —— comms 桥注入（项 4/5/6；缺省 comms 配置时构造于 agentDir/comms）
//   - identityMap?: IdentityMap —— 身份权威源注入（项 6；缺省构造于 <workDir>/identity/）
//   - comms.delivery? —— 输入配置（项 5：装配强制覆写为 auto，spec 契约⑥ agent↔agent 不可 manual）
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition, AgentInstanceRecord, WorkLoopDefinition } from "../core/contracts.ts";
import type { DefinitionRegistry } from "../core/definitions/registry.ts";
import type { WorkLoopRunner } from "../workloop/runner.ts";
import type { CheckpointStore } from "../workloop/checkpoints.ts";
import type { CommsTransport } from "../memory/comms.ts";
import { CommsChannel, IdentityMap } from "../memory/comms.ts";
import { MemoryStore } from "../memory/store.ts";
import { DEFAULT_MARKET_CONFIG } from "../config.ts";
import type { LedgerPort } from "./ledger-port.ts";
import { RESERVED_IDS } from "../economy/central-pool.ts";
import type { RuleBootstrap } from "./rule-bootstrap.ts";
import { MemoryHost } from "./memory-host.ts";
import { AgentRuntime } from "./agent-runtime.ts";
import { CommsBridge } from "./comms-bridge.ts";
import { validateAgainstSchema } from "./json-schema-min.ts";
import type { AgentRef, AssembleOptions, MemorySpec } from "./types.ts";
import { ASSEMBLY_DIR, IDENTITY_DIR, PUBLIC_DOMAIN_DIR, ROUND_SENTINEL, validateMemorySpec } from "./types.ts";

export interface AgentAssemblerDeps {
  registry: DefinitionRegistry;
  agentStore: { getAgent(id: string): AgentInstanceRecord | undefined; insertAgent(r: AgentInstanceRecord): void; };
  ledger: LedgerPort;
  ruleBootstrap: RuleBootstrap;
  runner: WorkLoopRunner;
  workDir: string;                       // <root>
  comms?: { transport: CommsTransport; identity: { agentId: string; tenantId: string; sessionId: string }; delivery?: "auto" | "manual" | "hybrid" };
  now?: () => number;
  /** 增补（见文件头）：agentId 生成器（缺省 randomUUID）。 */
  idGen?: () => string;
  /** 增补（见文件头）：真实 CheckpointStore（T7 ruling：resume 无参 latest）。 */
  checkpointStore?: CheckpointStore;
  /** C 接线包（plan Task 10）：comms 桥注入（缺省：comms 配置时构造于 agentDir/comms；测试注入 spy）。 */
  bridge?: CommsBridge;
  /** C 接线包：IdentityMap 注入（缺省：构造于 <workDir>/identity/——权威源，spec 契约⑨）。 */
  identityMap?: IdentityMap;
}

/** 装配记录 = AgentInstanceRecord 结构超集（memorySpec/endowment；brief step 5 字段）。 */
export interface AssembledAgentRecord extends AgentInstanceRecord {
  memorySpec?: MemorySpec;
  endowment?: { K: number; initialFloor: number };
}

export interface AgentAssembler {
  assembleAgent(ref: AgentRef, opts: AssembleOptions): AgentRuntime;
}

export function createAgentAssembler(deps: AgentAssemblerDeps): AgentAssembler {
  return new Assembler(deps);
}

class Assembler implements AgentAssembler {
  private readonly deps: AgentAssemblerDeps;
  private readonly idGen: () => string;

  constructor(deps: AgentAssemblerDeps) {
    this.deps = deps;
    this.idGen = deps.idGen ?? randomUUID;
  }

  assembleAgent(ref: AgentRef, opts: AssembleOptions): AgentRuntime {
    // ── 1. 解析注册表 ─────────────────────────────────────────────
    const definition = this.deps.registry.resolve({ kind: "workloop", id: ref.id, version: ref.version });
    if (!definition) {
      throw new Error(`workloop not registered: ${ref.id}@${ref.version}`);
    }
    if (definition.kind !== "workloop") {
      throw new Error(`not a workloop definition: ${definition.kind}`);
    }
    const wlDef = definition as WorkLoopDefinition & { config?: unknown; memory?: MemorySpec };

    // ── 2a. config 过 configSchema（协调者裁决：最小 JSON Schema 子集）──
    const config = wlDef.config;
    if (config !== undefined) {
      const configErrors = validateAgainstSchema(config, wlDef.configSchema);
      if (configErrors.length > 0) {
        throw new Error(`config validation failed: ${configErrors[0]}`);
      }
    }

    // ── 2b. 注册预检（幂等冲突 oracle；agentId = 显式指定（项 8）或装配器派生 UUID）──
    const agentId = opts.agentId ?? this.idGen();
    if (this.deps.agentStore.getAgent(agentId)) {
      throw new Error(`agent already registered: ${agentId}`);
    }

    // ── 2b′. RESERVED_IDS 校验（spec §2：黑名单阻止外部装配；早于开户/记忆域初始化）──
    if (RESERVED_IDS.has(agentId)) {
      throw new Error(`reserved agent id: ${agentId}`);
    }

    // ── 2c. memory 声明校验 ───────────────────────────────────────
    const memorySpec = wlDef.memory ?? opts.memory;
    const memErrors = validateMemorySpec(memorySpec);
    if (memErrors.length > 0) {
      throw new Error(`memory spec invalid: ${memErrors.join("; ")}`);
    }

    // ── 3. 记忆域初始化（fresh / fork）────────────────────────────
    const agentDir = path.join(this.deps.workDir, ASSEMBLY_DIR, agentId);
    const pubDir = path.join(this.deps.workDir, PUBLIC_DOMAIN_DIR);
    const endowment: { K: number; initialFloor: number } = opts.endowment ?? {
      K: DEFAULT_MARKET_CONFIG.endowment.K,
      initialFloor: DEFAULT_MARKET_CONFIG.endowment.floor,
    };

    let created = false;
    try {
      if (opts.cloneMode === "fork") {
        this.initForkDomain(opts, agentDir);
      } else {
        mkdirSync(agentDir, { recursive: true });
      }

      const comms = this.deps.comms
        ? new CommsChannel(this.deps.comms.transport, this.deps.comms.identity, path.join(agentDir, "comms"))
        : undefined;
      const memory = new MemoryHost({
        workDir: agentDir,
        pubDir,
        ruleBootstrap: this.deps.ruleBootstrap,
        spec: memorySpec ?? {},
        ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
        ...(comms !== undefined ? { comms } : {}),
        // C 接线包项 2：seqProvider 注入——runner.currentSeqOf（in-flight 转移序号）
        // 为 MemoryHost 水位/revive 的 seq 来源（特性检测：旧 mock runner 无该方法时缺省 0）
        ...(typeof this.deps.runner.currentSeqOf === "function"
          ? { seqProvider: (): number => this.deps.runner.currentSeqOf(agentId) }
          : {}),
      });

      // C 接线包项 5/6：comms 装配产物——IdentityMap（权威源，注册 agentId → tenant/session）
      // + CommsBridge（收件缓冲；delivery 强制 auto 覆写配置——spec 契约⑥ agent↔agent 不可 manual）
      let bridge: CommsBridge | undefined;
      if (comms && this.deps.comms) {
        const identityMap = this.deps.identityMap ?? new IdentityMap(path.join(this.deps.workDir, IDENTITY_DIR));
        bridge = this.deps.bridge ?? new CommsBridge({
          inboxDir: path.join(agentDir, "comms"),
          channel: comms,
          identityMap,
          delivery: "auto", // 强制 auto（覆写 comms.delivery 输入配置）
        });
        bridge.registerIdentity(agentId, this.deps.comms.identity.tenantId, this.deps.comms.identity.sessionId);
        // 契约⑨ 刷新回调注册（session_start 刷新通知出口；下游消费者 = Task 12 pit-communicate 接线）
        bridge.registerSessionRefresh((_refreshAgentId, _sessionId) => {});
      }

      // ── 4. 开户（续跑幂等；!created → 续跑信号，注册预检已保证未注册 → 继续）──
      created = this.deps.ledger.open(agentId, endowment.K).created;

      // ── 5. 注册持久 ─────────────────────────────────────────────
      const record: AssembledAgentRecord = {
        id: agentId,
        schedulerInstanceId: opts.schedulerInstanceId,
        definition: this.buildDefinition(ref, config),
        memorySpec,
        endowment,
        status: "ready",
        createdAtRoundId: ROUND_SENTINEL,
        createdAt: this.deps.now ? this.deps.now() : Date.now(),
      };
      this.deps.agentStore.insertAgent(record);

      // ── 6. 组装 AgentRuntime（attachSdk 延迟到首次 run）──────────
      return new AgentRuntime({
        agentId,
        definition: record.definition,
        schedulerInstanceId: opts.schedulerInstanceId,
        runner: this.deps.runner,
        memory,
        ledger: this.deps.ledger,
        ...(this.deps.idGen !== undefined ? { idGen: this.deps.idGen } : {}),
        ...(this.deps.checkpointStore !== undefined ? { checkpointStore: this.deps.checkpointStore } : {}),
        ...(bridge !== undefined ? { bridge } : {}),
      });
    } catch (err) {
      // 失败清理：记忆域目录 + 本调用创建的账户（attempt-local；项 9：经 LedgerPort 接口）
      rmSync(agentDir, { recursive: true, force: true });
      if (created) {
        this.deps.ledger.removeAccount(agentId);
      }
      throw err;
    }
  }

  /** fork：源私域整库拷贝（目录级 cpSync——MemoryHost 布局下 workDir 即私域根）+ 拷贝后重建锚点索引。 */
  private initForkDomain(opts: AssembleOptions, agentDir: string): void {
    if (!opts.sourceAgentId) {
      throw new Error("fork requires sourceAgentId");
    }
    const srcDir = path.join(this.deps.workDir, ASSEMBLY_DIR, opts.sourceAgentId);
    if (!existsSync(srcDir)) {
      throw new Error(`source agent memory domain not found: ${opts.sourceAgentId}`);
    }
    cpSync(srcDir, agentDir, { recursive: true });
    // 拷贝后重建索引（源多文件跨文件不一致的修复路径；RuleRegistry 由 MemoryHost 构造重建——新实例读新目录）
    new MemoryStore(agentDir).rebuildIndex();
  }

  /** AgentDefinition 组装：绑定 workloop（id/version）+ config（定义级 config ?? {}）。 */
  private buildDefinition(ref: AgentRef, config: unknown): AgentDefinition {
    return {
      standard: {
        name: ref.id,
        capabilities: [],
        executionKind: "workloop",
        labels: {},
      },
      workLoop: { id: ref.id, version: ref.version, config: config ?? {} },
      custom: null,
    };
  }
}
