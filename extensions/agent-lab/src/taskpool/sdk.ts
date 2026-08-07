// sorter? SDK 端口（spec §7.1）：agent 工作会话内 reject/submit。
// 判别式返回（裁决 I5）：守卫失败对 agent 可见，不静默丢成果。

import type { SqliteTaskStore } from "./tasks.ts";

export interface SorterSdkPort {
  rejectTask(taskId: string, reason: string): { ok: true } | { ok: false; error: string };
  submitTask(taskId: string, outputRef: string): { ok: true } | { ok: false; error: string };
}

export interface SorterSdkDeps {
  store: SqliteTaskStore;
  /** 当前会话 agent id（装配层注入；v1 固定 id 或运行时解析）。 */
  agentId: () => string;
}

export interface SorterSdkTarget { sorter?: SorterSdkPort }

export function mountSorterSdk(sdk: SorterSdkTarget, deps: SorterSdkDeps): void {
  if (!deps.store) return; // 防御性：引擎缺失不挂
  sdk.sorter = {
    rejectTask(taskId: string, reason: string) {
      const r = deps.store.reject(deps.agentId(), taskId, reason);
      return r === "rejected" ? { ok: true } : { ok: false, error: r };
    },
    submitTask(taskId: string, outputRef: string) {
      const r = deps.store.submit(deps.agentId(), taskId, outputRef);
      return r === "submitted" ? { ok: true } : { ok: false, error: r };
    },
  };
}
