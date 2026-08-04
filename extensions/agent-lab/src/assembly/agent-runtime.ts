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
// 2. attachSdk 目标（C 接线包项 1 落实）：runner 增加 onSdkBuilt 扩展钩子（Task 10
//    对 runner.ts 的最小增补——brief 项 1 "runner sdkExtensions 真实钩子"要求所在）——
//    首次挂载时经 onSdkBuilt 注册真实挂载回调（每次 buildSDK 后 memory.attachSdk(sdk)）；
//    无钩子的旧 runner/mock（特性检测）→ 回退惰性 stub（既有行为，测试兼容）。
// 3. DSP restore 顺序：loadSnapshot(seq) 为 spec 契约⑦交付项，记忆系统 Task 11 未
//    实现（src/memory/dsp.ts 仅有 build/snapshot/restore）→ 特性检测回退：无
//    loadSnapshot → build("realtime")（无快照回退新鲜检索，契约⑦防御语义）；未来
//    loadSnapshot 交付后自动走快照路径（loadSnapshot(latest seq) → build("restore")）。
// 4. onCheckpoint→dsp.snapshot（项 3）：spec 契约⑦ snapshot 生产者 = runner onCheckpoint
//    钩子（按 agentInstanceId 过滤 + dispose 反注册）——首次挂载时注册；同钩子顺带
//    bridge.ack(seq)（契约⑥ ack：checkpoint seq ≥ mergedAtSeq → inbox 删除——项 4
//    drain 生命周期的清理侧，一行接线）。
// 5. inbox drainInto 拼接 task 前缀（项 4）：run/resume 前 drain 未并入消息 → 每条
//    带 "task: " 前缀拼接进任务文本（spec 契约⑥ 纸带注入的 v1 简化——消息并入任务
//    文本而非 WorkContext.messages，来源标记 peer:<id> 留 Task 12）。
import { randomUUID } from "node:crypto";
import type { WorkLoopResult, WorkLoopSDK } from "../workloop/contracts.ts";
import type { WorkLoopRunRequest, WorkLoopRunner } from "../workloop/runner.ts";
import type { AgentDefinition } from "../core/contracts.ts";
import type { CheckpointStore } from "../workloop/checkpoints.ts";
import type { DspBuilder, DspInput } from "../memory/dsp.ts";
import type { MemoryHost } from "./memory-host.ts";
import type { LedgerPort } from "./ledger-port.ts";
import type { CommsBridge } from "./comms-bridge.ts";
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
  /** C 接线包（plan Task 10）：comms 桥（收件缓冲 drain/ack + 身份注册产物）；装配器构造注入。 */
  bridge?: CommsBridge;
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
  /** C 接线包：装配产物只读访问面（Task 11/12 接线 + 测试观测）。 */
  readonly memory: MemoryHost;
  readonly bridge?: CommsBridge;
  private readonly deps: AgentRuntimeDeps;
  private readonly idGen: () => string;
  private readonly stopSweeper: () => void;
  private sdkAttached = false;
  private sdkStub?: WorkLoopSDK;
  private unregisterSdkHook?: () => void;
  private unregisterCheckpointHook?: () => void;

  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
    this.agentId = deps.agentId;
    this.memory = deps.memory;
    this.bridge = deps.bridge;
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
    const task = this.drainInbox(req.task); // 项 4：收件缓冲并入任务文本（"task:" 前缀）
    return this.deps.runner.run(
      this.buildRequest(task, req.config, req.optimizationRoundId, req.signal),
    );
  }

  /**
   * resume(checkpointId?)：checkpointId → resumeFromCheckpointId；无参 → latest
   * （checkpointStore.latest，适配说明见文件头 1）。task：恢复 checkpoint 关联任务文本
   * ——CheckpointRecord 无 task 字段 → ""（spec：无则 ""）。
   * 契约⑩ + ②（同钩子）：resume 目标 checkpoint 的 seq 水位 prune——
   * comms.pruneDedup(seq) + pipeline.pruneIdem(seq)（防"已投递被拒收/键存在条目已回滚"不对称）。
   */
  async resume(checkpointId?: string): Promise<WorkLoopResult> {
    this.attachSdkOnce();
    this.restoreDspOrder();
    // 契约⑩ + ②：prune seq = resume 目标 checkpoint 的 seq（显式 = get().seq；无参 = latest().seq ?? 0）
    const targetSeq = this.resolveTargetSeq(checkpointId);
    this.deps.memory.comms?.pruneDedup(targetSeq);
    this.deps.memory.pipeline.pruneIdem(targetSeq);
    let resumeFromCheckpointId: string | undefined;
    if (checkpointId !== undefined) {
      resumeFromCheckpointId = checkpointId;
    } else {
      const latest = this.deps.checkpointStore?.latest(this.agentId);
      resumeFromCheckpointId = latest?.checkpointId;
    }
    const request = this.buildRequest(this.drainInbox(""), undefined, undefined, undefined);
    if (resumeFromCheckpointId !== undefined) {
      request.resumeFromCheckpointId = resumeFromCheckpointId;
    }
    return this.deps.runner.run(request);
  }

  /** 契约③：停止 TTL sweeper + 反注册钩子（项 1/3）+ comms 清理（当前无清理 API——预留接线点）。 */
  dispose(): void {
    this.stopSweeper();
    this.unregisterSdkHook?.();
    this.unregisterCheckpointHook?.();
    // comms 清理：MemoryHost/CommsChannel 当前无监听/定时器清理 API（Task 5/记忆系统
    // 交付面）；comms bridge（Task 9）注册的反注册接线后在此补充。
  }

  // ---- 内部 ----

  /**
   * 契约⑤① + 项 1：首次挂载——runner sdkExtensions 真实钩子注册（每次 buildSDK 后
   * memory.attachSdk(sdk)）；无钩子（特性检测，旧 mock/runner）→ 惰性 stub 回退。
   * 项 3：同点注册 onCheckpoint（checkpoint 事件 → dsp.snapshot(seq, "realtime") +
   * bridge.ack(seq)；按 agentInstanceId 过滤；dispose 反注册）。
   */
  private attachSdkOnce(): void {
    if (this.sdkAttached) return;
    this.sdkAttached = true;
    if (typeof this.deps.runner.onSdkBuilt === "function") {
      this.unregisterSdkHook = this.deps.runner.onSdkBuilt((sdk) => this.deps.memory.attachSdk(sdk));
    } else {
      this.sdkStub ??= {} as WorkLoopSDK;
      this.deps.memory.attachSdk(this.sdkStub);
    }
    if (typeof this.deps.runner.onCheckpoint === "function") {
      this.unregisterCheckpointHook = this.deps.runner.onCheckpoint((info) => {
        if (info.agentInstanceId !== this.agentId) return; // 按 agentInstanceId 过滤（spec 契约⑦）
        this.deps.memory.dsp.snapshot(info.seq, "realtime"); // snapshot 生产者（项 3）
        this.deps.bridge?.ack(info.seq); // 契约⑥ ack：mergedAtSeq ≤ seq → inbox 删除（项 4 清理侧）
      });
    }
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

  /**
   * 项 4：收件缓冲 drainInto → 任务文本拼接（每条 "task: " 前缀；原任务文本接在后）。
   * 无桥 / 无未并入消息 → 原样返回。drain seq = 当前 latest checkpoint seq
   * （mergedAtSeq 打点基准；ack 时 seq ≥ mergedAtSeq 即删）。
   */
  private drainInbox(task: string): string {
    const bridge = this.deps.bridge;
    if (!bridge) return task;
    const merged = bridge.drainInto(this.latestSeq());
    if (merged.length === 0) return task;
    const prefix = merged.map((m) => `task: ${m.tapeFragment}`).join("\n");
    return task.length > 0 ? `${prefix}\n${task}` : prefix;
  }

  /** latest checkpoint seq（无 checkpointStore / 无 checkpoint → 0）。 */
  private latestSeq(): number {
    return this.deps.checkpointStore?.latest(this.agentId)?.seq ?? 0;
  }

  /**
   * resume 目标 seq（契约②/⑩）：显式 checkpointId → CheckpointStore.get(agentId, id).seq；
   * 无参 → latest(agentId)?.seq ?? 0（CheckpointRecord.seq 可选——旧 checkpoint 无 seq → 0）。
   */
  private resolveTargetSeq(checkpointId: string | undefined): number {
    if (checkpointId !== undefined) {
      return this.deps.checkpointStore?.get(this.agentId, checkpointId).seq ?? 0;
    }
    return this.latestSeq();
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
