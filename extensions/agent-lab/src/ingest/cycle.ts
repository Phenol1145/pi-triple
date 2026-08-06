// 周期流（spec §5 实现选择 b）：摄入模块自带周期定时器——机械行为不进 agent 路径。
// 每轮：跑摄入管道 → 为每个变更文档派发"语义分解"任务（labels.strategy="weighted"
// 经 resolveStrategy 第 2 级路由）。单轮失败不破坏周期：下轮幂等重试。

import type { DispatchRequest } from "../scheduler/runner-types.ts";
import type { IngestPipeline, IngestSummary } from "./pipeline.ts";

export const MEMORY_MAINTENANCE_ROLE = "memory-maintenance";

/** 语义分解任务文本（内嵌协议，spec §6）。 */
export function semanticSplitTask(relPath: string): string {
  return `语义分解 ${relPath}：读取该文档，识别可独立成立的语义事实（定义/决策/规则/结论/不变量），每条经 sdk.memory.write 写一个 MemoryEntry（kind=fact，anchors=文档标签+更细主题锚点，content=事实本身，末尾附 "源: ${relPath}"）。不改写原文档、不删除指针条目。`;
}

export interface IngestCycleDeps {
  pipeline: IngestPipeline;
  dispatch: (req: DispatchRequest) => Promise<unknown>;
  intervalMs: number;
  role?: string;
}

export async function runIngestCycleOnce(deps: IngestCycleDeps): Promise<IngestSummary> {
  const summary = deps.pipeline.run();
  const role = deps.role ?? MEMORY_MAINTENANCE_ROLE;
  for (const doc of summary.changed) {
    await deps.dispatch({
      traceId: `ingest-cycle:${Date.now()}:${doc.relPath}`,
      role,
      task: semanticSplitTask(doc.relPath),
      taskCategory: "memory-maintenance",
      caller: "ingest-cycle",
      labels: { strategy: "weighted", relPath: doc.relPath },
      mode: "execute",
    });
  }
  return summary;
}

export function startIngestCycle(deps: IngestCycleDeps): { stop(): void } {
  const timer = setInterval(() => {
    runIngestCycleOnce(deps).catch(() => {
      // 单轮失败静默跳过：下轮幂等重试（管道内容相等判定保证不重复写）
    });
  }, deps.intervalMs);
  timer.unref(); // 定时器不阻进程退出（MemoryHost 既有惯例）
  return { stop() { clearInterval(timer); } };
}
