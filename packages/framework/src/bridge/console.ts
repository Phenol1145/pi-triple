/**
 * ptl hub console —— PTH 活动状态观测台（API 覆盖补齐后的命令行面）
 *
 *   ptl hub console --kernel    核心活动状态（batches/workers/当前任务/任务队列/autopilot）
 *   ptl hub console --sandbox   沙盒活动状态（kernel 池/编译统计/debug 会话）
 *   ptl hub console             概览（kernel + sandbox 摘要）
 */

import { PthClient } from "./client.js";

interface KernelStatus {
  kernel?: { connected?: boolean };
  autopilot?: unknown;
  batches?: Array<{ id: string; pid: number; workers: string[]; currentTasks: Record<string, string>; idleRatio: number; alive: boolean }>;
  tasks?: { pending?: number; claimed?: number; submitted?: number; completed?: number; rejected?: number; escalated?: number; total?: number };
  watchdog?: { crashLog?: unknown[] };
  collectedAt?: number;
}

interface SandboxStatus {
  sandbox?: {
    pools?: Array<{ lang: string; inFlight: number; idle: number; size: number; capacity: number }>;
    compiled?: unknown;
    debug?: { sessions: number; maxSessions: number };
  };
  url?: string;
  collectedAt?: number;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export async function cmdHubConsole(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = PthClient.fromConfig();
  if (!client) {
    console.error("❌ PTH 未配置（pi-triple.json pth.url/pth.token 或 PTH_URL/PTH_TOKEN）");
    return;
  }
  const showKernel = "kernel" in flags || (!("sandbox" in flags));
  const showSandbox = "sandbox" in flags || (!("kernel" in flags));

  if (showKernel) {
    try {
      const st = await client.requestJson("/api/v1/kernel/status", { method: "GET" }) as KernelStatus;
      console.log("═══ PTH 核心活动状态 ═══");
      console.log(`kernel: ${st.kernel?.connected ? "已连接" : "未连接"}`);
      const t = st.tasks ?? {};
      console.log(`任务队列: pending=${t.pending ?? 0} claimed=${t.claimed ?? 0} submitted=${t.submitted ?? 0} completed=${t.completed ?? 0} rejected=${t.rejected ?? 0} escalated=${t.escalated ?? 0}（total=${t.total ?? 0}）`);
      console.log(`batches（${st.batches?.length ?? 0}）:`);
      for (const b of st.batches ?? []) {
        const busy = Object.keys(b.currentTasks ?? {}).length;
        console.log(`  ${b.id} pid=${b.pid} alive=${b.alive ? "✓" : "✗"} workers=${b.workers.length} busy=${busy} idle=${(b.idleRatio * 100).toFixed(0)}%`);
        for (const [workerId, taskId] of Object.entries(b.currentTasks ?? {})) {
          console.log(`    ${workerId} → 执行中 ${taskId}`);
        }
      }
      if (st.autopilot) console.log(`autopilot: ${JSON.stringify(st.autopilot).slice(0, 200)}`);
      const crashes = st.watchdog?.crashLog?.length ?? 0;
      if (crashes > 0) console.log(`watchdog 崩溃记录: ${crashes} 条`);
    } catch (e) {
      console.error(`❌ kernel 状态获取失败: ${(e as Error).message}`);
    }
  }

  if (showSandbox) {
    try {
      const st = await client.requestJson("/api/v1/kernel/sandbox", { method: "GET" }) as SandboxStatus;
      console.log("═══ PTH 沙盒活动状态 ═══");
      for (const p of st.sandbox?.pools ?? []) {
        console.log(`  ${p.lang} 池: inFlight=${p.inFlight} idle=${p.idle} size=${p.size}/capacity=${p.capacity}`);
      }
      if (st.sandbox?.compiled) console.log(`  编译统计: ${JSON.stringify(st.sandbox.compiled).slice(0, 200)}`);
      const d = st.sandbox?.debug;
      if (d) console.log(`  debug 会话: ${d.sessions}/${d.maxSessions}`);
    } catch (e) {
      console.error(`❌ sandbox 状态获取失败: ${(e as Error).message}`);
    }
  }
  void passthrough;
  void fmtUptime;
}
