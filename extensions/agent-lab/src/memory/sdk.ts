// WorkLoopSDK 挂载（plan Task 12）：sdk.memory/sdk.comms 可选扩展 + 挂载器。
//
// 设计要点：
// - 纯增量：contracts.ts 只加可选字段（memory?/comms?），零行为变更——未挂载时
//   字段为 undefined，调用方可安全检查判定记忆能力未启用
// - 类型方向：本模块定义端口接口（MemorySdkPort/CommsSdkPort），contracts.ts 侧
//   `import type` 引用（双向均类型级、运行时零依赖；memory 模块不 import contracts）
// - retrieve 走 MemoryStore（deps.store 必填——brief Produces 要求
//   retrieve(opts): MemoryEntry[]，无 store 引用不可实现；deps 最小必要增补，
//   先例：Task 11 opts.dir 扩展经裁决背书）
// - 防御性挂载：deps.pipeline/store 缺失 → memory 端口不挂；comms 缺失 → comms
//   端口不挂（brief 冒烟以 null 传入未用依赖）
// - dsp 纳入 deps 但 v1 无 SDK 端口面（装配层直接使用；裁决①：挂载时显式传 dir）
import type { MemoryEntry } from "./entry.ts";
import type { MemoryPipeline } from "./pipeline.ts";
import type { CommsChannel } from "./comms.ts";
import type { MemoryStore } from "./store.ts";
import type { DspBuilder } from "./dsp.ts";

/** sdk.memory 端口（contracts.ts WorkLoopSDK.memory? 的类型来源）。 */
export interface MemorySdkPort {
  /** 沉淀写入：走 MemoryPipeline——校验/幂等/溯源/事件自动（Task 6）。 */
  write(e: Partial<MemoryEntry> & { idempotencyKey: string }): ReturnType<MemoryPipeline["write"]>;
  /** 检索：透传 MemoryStore.retrieve 查询（锚点/kind/status/excludeDrafts；无参 = 全量）。 */
  retrieve(opts: unknown): MemoryEntry[];
}

/** sdk.comms 端口（contracts.ts WorkLoopSDK.comms? 的类型来源）。 */
export interface CommsSdkPort {
  /** 纸带片段发送：走 CommsChannel（msgId 幂等/自我打点/≤4KB 拒绝）。 */
  send(to: string, tapeFragment: string): void;
}

/** 挂载目标（结构类型；WorkLoopSDK 扩展后天然满足此形状）。 */
export interface MemorySdkTarget {
  memory?: MemorySdkPort;
  comms?: CommsSdkPort;
}

export interface MemoryMountDeps {
  pipeline: MemoryPipeline;
  /** retrieve 所需（brief deps 增补——Produces 接口要求 retrieve 返回条目）。 */
  store: MemoryStore;
  comms: CommsChannel;
  /** v1 无 SDK 端口面（装配层直接使用）；裁决①：挂载时显式传 dir 构造。 */
  dsp: DspBuilder;
}

/**
 * 挂载 sdk.memory.write/retrieve + sdk.comms.send。
 * write 走 pipeline（校验/幂等/溯源自动）；retrieve 走 store；send 走 channel。
 * 防御性：pipeline/store 缺失 → memory 不挂；comms 缺失 → comms 不挂。
 */
export function mountMemorySdk(sdk: MemorySdkTarget, deps: MemoryMountDeps): void {
  if (deps.pipeline && deps.store) {
    sdk.memory = {
      write: (e) => deps.pipeline.write(e),
      retrieve: (opts) => deps.store.retrieve((opts ?? {}) as Parameters<MemoryStore["retrieve"]>[0]),
    };
  }
  if (deps.comms) {
    sdk.comms = {
      send: (to, tapeFragment) => {
        deps.comms.send(to, tapeFragment);
      },
    };
  }
}
