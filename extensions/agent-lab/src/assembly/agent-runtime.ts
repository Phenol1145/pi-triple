// AgentRuntime —— 装配层可运行经济主体（spec §3.1 / plan Task 7）。
//
// 职责：
// - run：签名收窄（N-I1）——agentInstanceId/workLoopId/workLoopVersion/traceId/
//   executionId/schedulerInstanceId 自填（绑定 AgentDefinition，外部不可指定别的
//   workloop）；optimizationRoundId 无 → ROUND_SENTINEL（""，runner 必填）；config
//   缺省 = definition.workLoop.config（绑定 workloop 的配置）；signal 透传
// - resume(checkpointId?)：checkpointId → resumeFromCheckpointId；无参 → latest
//   （CheckpointStore.latest，经可选 checkpointStore 依赖——适配说明见下）；task 填
//   恢复 checkpoint 关联任务文本——CheckpointRecord 无 task 字段 → ""（spec §3.1"无则 ''"）
// - dispose：sweeper 停止（构造时 memory.startSweeper 启动，契约③）+ comms 清理
//   （当前 MemoryHost/CommsChannel 无监听/定时器清理 API——预留，见适配说明）
// - run 前序（契约⑤①⑦）：首次 attachSdk + DSP restore 顺序
//
// 适配说明（对 brief 的按实际实现裁决，均已报告）：
// 1. checkpointStore?: CheckpointStore —— brief deps 未列，runner 亦无 latest 访问器
//    （brief 注记"按实际实现并在报告说明"）；spec §3.1 明确无参 resume = latest 经
//    CheckpointStore.latest（Task 6 交付项）→ 本类以可选依赖注入：有 → 无参 resume
//    解析 latest checkpointId；无 → 不带 resumeFromCheckpointId（退化为新 run）。
// 2. attachSdk 目标：runner 每次 run 内部新建 WorkLoopSDK（buildSDK 私有，Task 6 未
//    暴露 sdk 扩展钩子）——AgentRuntime 无法取得真实实例；以惰性 stub 完成"首次挂载"
//    调用面（契约⑤①流程），真实接线需 runner 暴露 sdk 扩展钩子（超出本任务文件范围）。
// 3. DSP restore 顺序：loadSnapshot(seq) 为 spec 契约⑦交付项，记忆系统 Task 11 未
//    实现（src/memory/dsp.ts 仅有 build/snapshot/restore）→ 特性检测回退：无
//    loadSnapshot → build("realtime")（无快照回退新鲜检索，契约⑦防御语义）；未来
//    loadSnapshot 交付后自动走快照路径（loadSnapshot(latest seq) → build("restore")）。
import { randomUUID } from "node:crypto";
import type { WorkLoopResult, WorkLoopSDK } from "../workloop/contracts.ts";
import type { WorkLoopRunRequest, WorkLoopRunner } from "../workloop/runner.ts";
import type { AgentDefinition } from "../core/contracts.ts";
import type { CheckpointStore } from "../workloop/checkpoints.ts";
import type { DspBuilder, DspInput } from "../memory/dsp.ts";
import type { MemoryHost } from "./memory-host.ts";
import type { LedgerPort } from "./ledger-port.ts";
import { ROUND_SENTINEL } from "./types.ts";

export interface AgentRuntimeDeps {
  agentId: string;
  definition: AgentDefinition;      // 绑定 workloop（自填 workLoopId/version；config 缺省来源）
  schedulerInstanceId: string;
  runner: WorkLoopRunner;
  memory: MemoryHost;
  ledger: LedgerPort;
  idGen?: () => string;             // 测试注入（默认 randomUUID）
  /** 适配增补（见文件头 1）：无参 resume 的 latest 解析（spec §3.1 经 CheckpointStore.latest）。 */
  checkpointStore?: CheckpointStore;
}

export interface AgentRunRequest {
  task: string;
  config?: unknown;
  optimizationRoundId?: string;
  signal?: AbortSignal;
}

/** DspBuilder 未来扩展面（契约⑦ loadSnapshot——记忆系统 Task 11 交付项；特性检测用）。 */
type DspWithLoadSnapshot = DspBuilder & { loadSnapshot?: (seq: number) => unknown };

export class AgentRuntime {
  readonly agentId: string;
  private readonly deps: AgentRuntimeDeps;
  private readonly idGen: () => string;
  private readonly stopSweeper: () => void;
  private sdkAttached = false;
  private sdkStub?: WorkLoopSDK;

  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
    this.agentId = deps.agentId;
    this.idGen = deps.idGen ?? randomUUID;
    // 契约③：AgentRuntime 生命周期内定时清扫（MemoryHost 缺省 60s）；dispose 停止
    this.stopSweeper = deps.memory.startSweeper();
  }

  /**
   * 收窄签名 run（N-I1）：身份字段自填绑定 definition；optimizationRoundId 无 →
   * ROUND_SENTINEL（""）。前序：首次 attachSdk + DSP restore 顺序（契约⑦）。
   */
  async run(req: AgentRunRequest): Promise<WorkLoopResult> {
    this.attachSdkOnce();
    this.restoreDspOrder();
    return this.deps.runner.run(
      this.buildRequest(req.task, req.config, req.optimizationRoundId, req.signal),
    );
  }

  /**
   * resume(checkpointId?)：checkpointId → resumeFromCheckpointId；无参 → latest
   * （checkpointStore.latest，适配说明见文件头 1）。task：恢复 checkpoint 关联任务文本
   * ——CheckpointRecord 无 task 字段 → ""（spec：无则 ""）。
   */
  async resume(checkpointId?: string): Promise<WorkLoopResult> {
    this.attachSdkOnce();
    this.restoreDspOrder();
    let resumeFromCheckpointId: string | undefined;
    if (checkpointId !== undefined) {
      resumeFromCheckpointId = checkpointId;
    } else {
      const latest = this.deps.checkpointStore?.latest(this.agentId);
      resumeFromCheckpointId = latest?.checkpointId;
    }
    const request = this.buildRequest("", undefined, undefined, undefined);
    if (resumeFromCheckpointId !== undefined) {
      request.resumeFromCheckpointId = resumeFromCheckpointId;
    }
    return this.deps.runner.run(request);
  }

  /** 契约③：停止 TTL sweeper + comms 清理（当前无清理 API——预留接线点）。 */
  dispose(): void {
    this.stopSweeper();
    // comms 清理：MemoryHost/CommsChannel 当前无监听/定时器清理 API（Task 5/记忆系统
    // 交付面）；comms bridge（Task 9）注册的反注册接线后在此补充。
  }

  // ---- 内部 ----

  /** 契约⑤①：memory 挂载（首次）。runner 内部新建 SDK——以惰性 stub 完成挂载调用面（见文件头 2）。 */
  private attachSdkOnce(): void {
    if (this.sdkAttached) return;
    this.sdkAttached = true;
    this.sdkStub ??= {} as WorkLoopSDK;
    this.deps.memory.attachSdk(this.sdkStub);
  }

  /**
   * 契约⑦ DSP restore 顺序：loadSnapshot(latest seq) → build("restore")；
   * 无快照（loadSnapshot 未交付/无快照文件）→ 回退 build("realtime")（新鲜检索，防御）。
   */
  private restoreDspOrder(): void {
    const dsp = this.deps.memory.dsp as DspWithLoadSnapshot;
    const input: DspInput = {
      state: undefined, // 本轮引擎状态在 runner 内部 MachineRuntime 中；此处为恢复顺序占位输入
      memory: {},
      env: {},
      budget: { used: 0, max: 0 },
    };
    if (typeof dsp.loadSnapshot === "function") {
      dsp.loadSnapshot(this.latestSeq());
      dsp.build(input, "restore");
    } else {
      dsp.build(input, "realtime");
    }
  }

  /** latest checkpoint seq（无 checkpointStore / 无 checkpoint → 0）。 */
  private latestSeq(): number {
    return this.deps.checkpointStore?.latest(this.agentId)?.seq ?? 0;
  }

  /** WorkLoopRunRequest 组装：自填身份字段 + 绑定 definition（config 缺省 = definition 配置）。 */
  private buildRequest(
    task: string,
    config: unknown,
    optimizationRoundId: string | undefined,
    signal: AbortSignal | undefined,
  ): WorkLoopRunRequest {
    const request: WorkLoopRunRequest = {
      traceId: this.idGen(),
      executionId: this.idGen(),
      agentInstanceId: this.agentId,
      optimizationRoundId: optimizationRoundId ?? ROUND_SENTINEL,
      workLoopId: this.deps.definition.workLoop.id,
      workLoopVersion: this.deps.definition.workLoop.version,
      config: config ?? this.deps.definition.workLoop.config,
      task,
      schedulerInstanceId: this.deps.schedulerInstanceId,
    };
    if (signal !== undefined) {
      request.signal = signal;
    }
    return request;
  }
}
