/**
 * pit/commands/trace — pit trace 命令族（状态追踪，CLI/TUI 共享）
 *
 * 读 trace provider 聚合视图（session-store）：credit/结算/遥测变化。
 * timeline 委托 store 的 traceTimeline（遍历 provider.timeline）。
 */
import type { CommandResult } from "../commands.js";
import { listAllTraces, resolveTrace, traceTimeline } from "../session/session-store.js";
import { parseFlags } from "./session.js";

export function execTraceLs(args: string[]): CommandResult {
  const { flags } = parseFlags(args);
  const traces = listAllTraces().filter((t) =>
    (!flags.template || t.templateId === flags.template) &&
    (!flags.agent || t.detail["agent"] === flags.agent || t.summary.includes(flags.agent)));
  if (flags.json === "true") return { ok: true, message: "", data: { traces } };
  if (traces.length === 0) return { ok: true, message: "  无追踪记录。运行竞价任务（pit lab 或 flow submit）产生 credit 变化", data: { traces } };
  return {
    ok: true,
    message: traces.map((t) => `  ${t.id.slice(0, 12)}  ${t.timestamp.slice(0, 16)}  ${t.summary}`).join("\n"),
    data: { traces },
  };
}

export function execTraceShow(id: string): CommandResult {
  const r = resolveTrace(id);
  if (!r.ok) return { ok: false, message: "", error: { code: "TRACE_NOT_FOUND", message: `轨迹 "${id}" 不存在` } };
  const detail = Object.entries(r.record.detail).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return { ok: true, message: `  追踪 ${r.record.id}\n  ${r.record.summary}\n${detail}` };
}

export function execTraceTimeline(agentId: string): CommandResult {
  if (!agentId) return { ok: false, message: "", error: { code: "USAGE", message: "用法: pit trace timeline <agentId>" } };
  const tl = traceTimeline(agentId);
  if (tl.length === 0) return { ok: true, message: `  无 ${agentId} 的轨迹` };
  return { ok: true, message: tl.map((t) => `  ${t.timestamp.slice(0, 16)}  ${t.summary}`).join("\n"), data: { traces: tl } };
}
