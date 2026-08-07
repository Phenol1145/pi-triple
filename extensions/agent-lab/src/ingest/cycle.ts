// 周期流（spec §5 实现选择 b）：摄入模块自带周期定时器——机械行为不进 agent 路径。
// 每轮：跑摄入管道 → 为每个变更文档向任务池 publish"语义分解"任务（模板实例化）。
// 路由职责交给分选器（Task 9 消费池中 pending 任务）。单轮失败不破坏周期：下轮幂等重试。

import type { SqliteTemplateRegistry } from "../taskpool/templates.ts";
import type { SqliteTaskStore } from "../taskpool/tasks.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../taskpool/semantic-split.ts";
import type { IngestPipeline } from "./pipeline.ts";

export interface IngestCycleDeps {
  pipeline: IngestPipeline;
  /** 任务池（裁决：摄入周期流迁移为池投递——路由职责交给分选器） */
  pool: { registry: SqliteTemplateRegistry; store: SqliteTaskStore };
  intervalMs: number;
}

export async function runIngestCycleOnce(deps: IngestCycleDeps): Promise<{ published: number }> {
  const summary = deps.pipeline.run();
  const { registry, store } = deps.pool;
  // 确保 semantic-split 模板已注册（幂等）
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  let published = 0;
  for (const doc of summary.changed) {
    const inst = registry.instantiate("semantic-split", { relPath: doc.relPath });
    if (!inst.ok) continue; // 模板缺失/参数错：跳过（下一轮幂等重试）
    store.publish({ templateId: "semantic-split", text: inst.text, labels: inst.labels, params: { relPath: doc.relPath }, createdBy: "ingest-cycle" });
    published++;
  }
  return { published };
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
