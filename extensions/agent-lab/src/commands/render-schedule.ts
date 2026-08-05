/**
 * commands/render-schedule.ts — /lab schedule 渲染（F/WP5 Task 28a）
 */

export interface ScheduledJobView {
  id: string;
  tenantId: string;
  taskType: string;
  scheduleKind: string;
  scheduleSpec: string;
  status: string;
  nextFireAt: number;
  lastFireAt: number | null;
  fireCount: number;
  createdBy: string;
  legalRef?: string;
}

export function renderScheduleList(jobs: ScheduledJobView[]): string {
  if (jobs.length === 0) return "暂无定时任务。";
  const lines: string[] = [];
  lines.push(`定时任务 ${jobs.length} 个:`);
  for (const j of jobs) {
    const next = j.nextFireAt > 0 ? new Date(j.nextFireAt).toISOString() : "-";
    const last = j.lastFireAt != null ? new Date(j.lastFireAt).toISOString().slice(0, 16) : "-";
    lines.push(
      `  ${j.id.slice(0, 8)}  ${j.status.padEnd(8)}  ${j.scheduleKind.padEnd(8)} ${j.scheduleSpec.padEnd(14)} ` +
        `type=${j.taskType}  next=${next}  last=${last}  fires=${j.fireCount}  tenant=${j.tenantId.slice(0, 8)}`,
    );
  }
  return lines.join("\n");
}

export function renderScheduleJobCreated(job: ScheduledJobView): string {
  return `已创建定时任务 ${job.id}\n  type=${job.taskType} kind=${job.scheduleKind} spec=${job.scheduleSpec}\n  nextFireAt=${new Date(job.nextFireAt).toISOString()}\n  tenant=${job.tenantId}`;
}

export function renderScheduleAction(action: string, id: string, detail?: string): string {
  return `${action} 定时任务 ${id}${detail ? `\n  ${detail}` : ""}`;
}
