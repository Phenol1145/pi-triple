// MemoryHost —— 装配层记忆宿主（plan Task 5 / spec §3.2 + 契约①③⑤⑧）。
//
// 职责：
// - 装配私域记忆子系统（MemoryStore/RuleRegistry/MemoryPipeline/WatermarkManager/
//   DspBuilder/CommsChannel 可选），全部目录显式落在 workDir（<root>/agents/<agentId>/，
//   契约⑧；装配器负责创建）
// - 联合检索（spec §3.2）：私域（水位过滤 watermark.visibleVersions(seq)）+ 公域
//   official（PublicDomainStore.listOfficialEntries）并集，去重按 id，私域优先；
//   可及公域 v1 = 全局公域全部 official
// - attachSdk（契约⑤①）：mountMemorySdk 后包装 sdk.memory.write——方言预检
//   （parseDialect 失败 → 结果附加 warning，不阻止写入；ruleRef EBNF 校验是权威）、
//   markdown 方言强制 status draft（draft-only）、revive 钩子（幂等命中既有条目且
//   isPendingActivation(entry, currentSeq) → watermark.revive(entry.id, nextSeq =
//   currentSeq + 1)；seq 来源 = 注入 seqProvider——AgentRuntime 提供 runner getter）
// - TTL sweeper（契约③）：draft && ttlExpiresAt < now → archived（store.update
//   status patch）；startSweeper(intervalMs) 返回停止函数（dispose 用）
//
// 对 brief MemoryHostDeps 的最小增补（本任务适配说明）：
// - seqProvider?: () => number —— brief 明确"seq 来源 = 注入的 seqProvider"，但
//   brief 接口未列字段；revive 钩子与联合检索均需要 seq。可选（缺省 0），AgentRuntime
//   注入 runner currentSeq getter
// - comms?: CommsChannel —— Produces 接口含 readonly comms?，但 brief deps 无来源；
//   可选注入（装配器构造），缺省不挂 comms 端口
// - trace?: PipelineTrace —— PipelineDeps.trace 必填；brief deps 无 trace。可选
//   （缺省 host 级占位 traceId="memory-host:<agentId>"，transitionSeq=0）
import { basename } from "node:path";
import type { MemoryEntry } from "../memory/entry.ts";
import { MemoryStore } from "../memory/store.ts";
import { RuleRegistry } from "../memory/rules.ts";
import { MemoryPipeline } from "../memory/pipeline.ts";
import type { PipelineTrace } from "../memory/pipeline.ts";
import { WatermarkManager } from "../memory/watermark.ts";
import { DspBuilder } from "../memory/dsp.ts";
import type { CommsChannel } from "../memory/comms.ts";
import { PublicDomainStore } from "../memory/public-domain.ts";
import { parseDialect } from "../memory/dialects.ts";
import { mountMemorySdk } from "../memory/sdk.ts";
import type { MemorySdkPort } from "../memory/sdk.ts";
import type { RuleBootstrap } from "./rule-bootstrap.ts";
import type { MemorySpec } from "./types.ts";
import type { WorkLoopSDK } from "../workloop/contracts.ts";

export interface MemoryHostDeps {
  workDir: string;                    // <root>/agents/<agentId>/（装配器创建）
  pubDir: string;                     // <root>/public-domain/
  ruleBootstrap: RuleBootstrap;       // 规则 fallback 链（公域只读视图）
  spec: MemorySpec;
  now?: () => number;
  /** 增补（适配说明见文件头）：seq 来源——AgentRuntime 注入 runner currentSeq getter；缺省 0。 */
  seqProvider?: () => number;
  /** 增补（适配说明见文件头）：comms 通道实例；缺省不挂 comms 端口。 */
  comms?: CommsChannel;
  /** 增补（适配说明见文件头）：pipeline 溯源（PipelineDeps.trace 必填）；缺省 host 级占位。 */
  trace?: PipelineTrace;
}

/** sdk.memory.write 输入（MemorySdkPort.write 的参数形状）。 */
type WriteInput = Parameters<MemorySdkPort["write"]>[0];
type WriteResult = ReturnType<MemoryPipeline["write"]>;
/** 方言预检包装后：结果可选附加 warning（结构子类型，兼容 MemorySdkPort.write 返回）。 */
type WriteResultWithWarning = WriteResult & { warning?: string };

const SWEEPER_DEFAULT_INTERVAL_MS = 60_000;

export class MemoryHost {
  readonly store: MemoryStore;        // 私域
  readonly rules: RuleRegistry;       // fallback → RuleBootstrap
  readonly pipeline: MemoryPipeline;
  readonly watermark: WatermarkManager;
  readonly dsp: DspBuilder;           // dir 显式（契约⑧）
  readonly comms?: CommsChannel;
  private deps: MemoryHostDeps;

  constructor(deps: MemoryHostDeps) {
    this.deps = deps;
    // 全部目录显式落在 workDir（契约⑧）：store/registry/pipeline 同 dir 共享文件布局
    // （entries/ index/ counters/ axiom.json rules/ buffer.jsonl idem.jsonl ...），
    // DSP 快照经 opts.dir 显式注入（dir/dsp-snapshots/）。
    this.store = new MemoryStore(deps.workDir);
    this.rules = new RuleRegistry(deps.workDir, { resolveRule: (id) => deps.ruleBootstrap.resolveRule(id) });
    this.rules.bootstrapAxiom(); // 私域自足（公理豁免走 isAxiom；本地 axiom.json 幂等）
    this.pipeline = new MemoryPipeline({
      dir: deps.workDir,
      store: this.store,
      rules: this.rules,
      trace: deps.trace ?? { traceId: `memory-host:${basename(deps.workDir)}`, transitionSeq: 0 },
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    this.watermark = new WatermarkManager(this.store);
    this.dsp = new DspBuilder(this.store, this.watermark, { dir: deps.workDir });
    this.comms = deps.comms;
  }

  /**
   * 联合检索（spec §3.2）：私域（水位过滤 watermark.visibleVersions(seq)）+ 公域
   * official（listOfficialEntries）并集，去重按 id，私域优先；可及公域 v1 = 全局
   * 公域全部 official。anchors 过滤 = 并集语义（同 store.retrieve：多锚点任一命中）。
   * 返回按 id 字典序稳定排序。
   */
  retrieve(opts: { anchors?: string[] } = {}): MemoryEntry[] {
    const anchors = opts.anchors ?? [];
    const matches = (e: MemoryEntry): boolean =>
      anchors.length === 0 || e.anchors.some((a) => anchors.includes(a));
    const out = new Map<string, MemoryEntry>();
    for (const e of this.watermark.visibleVersions(this.seq())) {
      if (matches(e)) out.set(e.id, e);
    }
    const pub = new PublicDomainStore(this.deps.pubDir);
    for (const e of pub.listOfficialEntries()) {
      if (matches(e) && !out.has(e.id)) out.set(e.id, e);
    }
    return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * 挂载 sdk.memory/sdk.comms（mountMemorySdk）+ 方言预检包装（契约⑤）+
   * revive 钩子（契约①）。
   * - 方言预检：spec.dialect 定义时 parseDialect(spec.dialect, content) 失败 →
   *   write 结果附加 `warning: "dialect precheck failed: ..."`（不阻止写入）；
   *   markdown 方言 → 强制 status draft（draft-only 语义）
   * - revive：写入前快照私域 id 集合——pipeline.write 返回的条目在写入前已存在
   *   （幂等命中）且 isPendingActivation(entry, currentSeq) → watermark.revive(
   *   entry.id, currentSeq + 1)（nextSeq = 该转移完成时将保存的 checkpoint seq）
   */
  attachSdk(sdk: WorkLoopSDK): void {
    mountMemorySdk(sdk, {
      pipeline: this.pipeline,
      store: this.store,
      comms: this.comms ?? (undefined as unknown as CommsChannel), // 缺省不挂 comms 端口（mountMemorySdk 内部 falsy 判定）
      dsp: this.dsp,
    });
    if (sdk.memory) {
      const base = sdk.memory.write;
      sdk.memory.write = (e) => this.wrapWrite(base, e);
    }
  }

  /**
   * TTL sweeper（契约③）：draft && ttlExpiresAt < now → archived（store.update
   * status patch）；返回清理数。幂等：二次调用 0。
   */
  sweepDrafts(): number {
    const now = this.now();
    let swept = 0;
    for (const entry of this.store.retrieve({ status: ["draft"] })) {
      if (entry.ttlExpiresAt !== undefined && entry.ttlExpiresAt < now) {
        this.store.update(entry.id, { status: "archived" });
        swept += 1;
      }
    }
    return swept;
  }

  /** 周期清扫（缺省 60s）；返回停止函数（AgentRuntime.dispose 用）。 */
  startSweeper(intervalMs: number = SWEEPER_DEFAULT_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      this.sweepDrafts();
    }, intervalMs);
    return () => clearInterval(timer);
  }

  // ---- 内部 ----

  private seq(): number {
    return this.deps.seqProvider ? this.deps.seqProvider() : 0;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 方言预检 + 幂等写入 + revive 钩子（sdk.memory.write 包装）。 */
  private wrapWrite(base: MemorySdkPort["write"], e: WriteInput): WriteResultWithWarning {
    // 幂等命中判定：写入前已存在的条目 id（listIds 快照；不依赖输入是否携带 id）
    const preIds = new Set(this.store.listIds());
    let input: WriteInput = e;
    const warnings: string[] = [];
    if (this.deps.spec.dialect !== undefined) {
      const parsed = parseDialect(this.deps.spec.dialect, e.content ?? "");
      if (!parsed.ok) {
        warnings.push(`dialect precheck failed: ${parsed.errors.join("; ")}`);
      }
      if (this.deps.spec.dialect === "markdown") {
        input = { ...e, status: "draft" }; // draft-only 语义：恒 draft
      }
    }
    const result = base(input);
    if (result.ok && preIds.has(result.entry.id)) {
      const currentSeq = this.seq();
      if (this.watermark.isPendingActivation(result.entry, currentSeq)) {
        this.watermark.revive(result.entry.id, currentSeq + 1); // nextSeq = 下一 checkpoint seq
      }
    }
    return warnings.length > 0 ? { ...result, warning: warnings.join("; ") } : result;
  }
}
