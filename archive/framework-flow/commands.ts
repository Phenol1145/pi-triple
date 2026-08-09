/**
 * ptl-flow CLI 命令（薄层，调 store/engine/edit）
 */
import fs from "node:fs";
import path from "node:path";
import { FlowStore } from "./store.js";
import type { RunSummary } from "./store.js";
import { validateFlow } from "./schema.js";
import { setValue, editGraph, approve, reject } from "./edit.js";
import type { EditResult } from "./edit.js";
import type { RunResult } from "./engine.js";
import { emitJson } from "@pi-triple/shared";

// ─── helpers ──────────────────────────────────────────────────

function store(): FlowStore {
  return new FlowStore();
}

/** runId 解析：支持完整 UUID 或唯一前缀 */
function resolveRunId(s: FlowStore, input: string): string {
  if (!input) { console.log("  \x1b[31m❌ 缺少 runId（运行 ptl flow ls 查看已有工作流）\x1b[0m"); process.exit(1); }
  if (s.hasRun(input)) return input;
  const matches = s.listRuns().filter((r) => r.runId.startsWith(input)).map((r) => r.runId);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.log(`  \x1b[31m❌ "${input}" 匹配多个工作流: ${matches.map((m) => m.slice(0, 8)).join(", ")}\x1b[0m`);
    process.exit(1);
  }
  console.log(`  \x1b[31m❌ 工作流 "${input.slice(0, 8)}…" 不存在\x1b[0m`);
  console.log("  运行 ptl flow ls 查看已有工作流");
  process.exit(1);
}

function requireRun(s: FlowStore, runId: string): string {
  return resolveRunId(s, runId);
}

function formatStatus(s: string): string {
  switch (s) {
    case "running":     return "🟢 running";
    case "waiting_human": return "🟡 waiting_human";
    case "failed":      return "🔴 failed";
    case "done":        return "✅ done";
    default:            return s;
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ");
}

function printLine(s: string): void { console.log("  " + s); }

// ─── run ─────────────────────────────────────────────────────

export async function cmdFlowRun(filePath: string, inputArgs: string[]): Promise<void> {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.log(`  \x1b[31m❌ 文件不存在: ${abs}\x1b[0m`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(abs, "utf-8"));
  const vr = validateFlow(raw);
  if (!vr.ok) {
    for (const err of vr.errors) console.log(`  \x1b[31m❌ ${err}\x1b[0m`);
    process.exit(1);
  }
  if (vr.warnings.length > 0) {
    for (const w of vr.warnings) console.log(`  \x1b[33m⚠️  ${w}\x1b[0m`);
  }

  // 解析 k=v → input
  const input: Record<string, string> = {};
  for (const arg of inputArgs) {
    const eq = arg.indexOf("=");
    if (eq > 0) input[arg.slice(0, eq)] = arg.slice(eq + 1);
  }

  const s = store();
  const runId = s.createRun(vr.def, input);
  const meta = s.loadMeta(runId);
  console.log(`  启动: ${meta.name} (${runId.slice(0, 8)}…)`);

  const { makeRunFlowV2 } = await import("./engine.js");
  const { makeSpawnAgent } = await import("./pm.js");
  const runFlow = makeRunFlowV2(makeSpawnAgent());

  const result = await runFlow(s, runId);
  switch (result.status) {
    case "done":
      console.log(`  \x1b[32m✅ 工作流完成\x1b[0m`);
      break;
    case "failed":
      console.log(`  \x1b[31m❌ 工作流失败\x1b[0m`);
      if (result.error) console.log(`  ${result.error}`);
      break;
    case "waiting_human":
      console.log(`  \x1b[33m⏳ 等待人工审批\x1b[0m`);
      console.log(`  ptl flow show ${runId.slice(0, 8)}  — 查看详情`);
      console.log(`  ptl flow approve ${runId.slice(0, 8)}  — 批准`);
      console.log(`  ptl flow reject ${runId.slice(0, 8)}  — 驳回`);
      break;
  }
}

// ─── status ──────────────────────────────────────────────────

export async function cmdFlowStatus(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  const meta = s.loadMeta(runId);
  const checkpoints = s.listCheckpoints(runId);
  const state = s.loadState(runId);

  console.log(`  \x1b[1m${meta.name}\x1b[0m  (${meta.runId.slice(0, 8)}…)`);
  console.log(`  状态: ${formatStatus(meta.status)}  ·  步骤: ${meta.stepCount}`);
  console.log(`  创建: ${formatDate(meta.createdAt)}  ·  输入: ${JSON.stringify(meta.input)}`);
  console.log("");

  if (checkpoints.length === 0) {
    console.log("  \x1b[2m暂无已完成的步骤\x1b[0m");
    return;
  }

  // 当前节点：最后一个 checkpoint 之后的入边目标
  const lastCp = checkpoints[checkpoints.length - 1];
  const currentNode = lastCp.status === "completed" ? "(下一节点待定)" : lastCp.nodeId;
  console.log(`  当前节点: \x1b[1m${currentNode}\x1b[0m`);
  console.log("");

  // 最近 3 个 checkpoint
  const recent = checkpoints.slice(-3);
  console.log(`  \x1b[2m${"NODE".padEnd(18)}STATUS      AGE\x1b[0m`);
  for (const cp of recent) {
    const age = Math.floor((Date.now() - cp.finishedAt!) / 1000);
    const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`;
    const status = cp.status === "completed" ? "✅" : "❌";
    console.log(`  ${cp.nodeId.padEnd(18)}${status}${String(ageStr).padStart(10)}`);
  }
}

// ─── show ────────────────────────────────────────────────────

export async function cmdFlowShow(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  const meta = s.loadMeta(runId);
  const state = s.loadState(runId);
  const checkpoints = s.listCheckpoints(runId);

  console.log(`  \x1b[1m${meta.name}\x1b[0m  (${meta.runId})`);
  console.log("");

  console.log("  \x1b[1mState:\x1b[0m");
  console.log(JSON.stringify(state, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  console.log("");

  if (checkpoints.length === 0) {
    console.log("  \x1b[2m暂无 checkpoints\x1b[0m");
  } else {
    for (const cp of checkpoints) {
      const seq = String(cp.seq).padStart(3, "0");
      console.log(`  \x1b[1m--- ${seq}-${cp.nodeId}\x1b[0m  ${cp.status}`);
      if (cp.output) {
        const truncated = cp.output.length > 500 ? cp.output.slice(0, 500) + "…" : cp.output;
        console.log(`  ${truncated}`);
      }
      console.log("");
    }
  }

  // 如果有 pending 展示 message
  const pending = s.loadPending(runId);
  if (pending) {
    console.log(`  \x1b[33m⏳ 等待审批: ${pending.message}\x1b[0m`);
  }
}

// ─── ls ──────────────────────────────────────────────────────

export function cmdFlowLs(jsonMode?: boolean): void {
  const s = store();
  const runs = s.listRuns();

  if (jsonMode) {
    emitJson({ runs: runs.map((r) => ({ runId: r.runId, name: r.name, status: r.status, stepCount: r.stepCount, createdAt: r.createdAt })) });
    return;
  }

  if (runs.length === 0) {
    console.log("\n  暂无工作流。启动: ptl flow run <flow.json>");
    console.log("");
    return;
  }

  console.log("");
  console.log(`  \x1b[2m${"RUN ID".padEnd(14)}NAME                  STATUS         STEPS  CREATED\x1b[0m`);
  for (const r of runs) {
    const id = r.runId.slice(0, 8);
    const name = (r.name ?? "?").padEnd(22);
    const status = formatStatus(r.status).padEnd(16);
    const steps = String(r.stepCount).padStart(3);
    const created = formatDate(r.createdAt);
    console.log(`  ${id.padEnd(14)}${name}${status}${steps}    ${created}`);
  }

  console.log(`\n  查看: \x1b[36mptl flow status <id>\x1b[0m  ·  批准: \x1b[36mptl flow approve <id>\x1b[0m\n`);
}

// ─── approve / reject ────────────────────────────────────────

async function doApproveOrReject(runId: string, note: string | undefined, isApprove: boolean): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  const fn = isApprove ? approve : reject;
  const actionName = isApprove ? "批准" : "驳回";

  let result: EditResult;
  try {
    result = await fn(s, runId, note);
  } catch (err: any) {
    console.log(`  \x1b[31m❌ ${actionName}失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  if (!result.ok) {
    console.log(`  \x1b[31m❌ ${actionName}失败: ${result.error ?? "未知错误"}\x1b[0m`);
    process.exit(1);
  }

  // approve/reject 后流程可能再次进入人工门
  if (result.status === "waiting_human") {
    console.log(`  \x1b[33m⏳ 再次等待人工审批\x1b[0m`);
    console.log(`  ptl flow show ${runId.slice(0, 8)}  — 查看详情`);
  } else {
    console.log(`  \x1b[32m✅ 工作流已完成\x1b[0m`);
  }
}

export async function cmdFlowApprove(runId: string, note?: string): Promise<void> {
  await doApproveOrReject(runId, note, true);
}

export async function cmdFlowReject(runId: string, note?: string): Promise<void> {
  await doApproveOrReject(runId, note, false);
}

// ─── resume ──────────────────────────────────────────────────

export async function cmdFlowResume(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);

  // v2 barrier resume (editing state)
  const meta = s.loadMeta(runId);
  if (meta.status === "editing") {
    try {
      const { resumeV2 } = await import("./edit.js");
      const { makeResumeFlowV2 } = await import("./engine.js");
      const { makeSpawnAgent } = await import("./pm.js");
      const engineResume = makeResumeFlowV2(makeSpawnAgent());
      const result = await resumeV2(s, runId, engineResume);
      if (result.ok) {
        if (result.status === "waiting_human") {
          console.log(`  \x1b[33m⏳ 等待人工审批\x1b[0m`);
          if (result.error) console.log(`  \x1b[33m${result.error}\x1b[0m`);
        } else {
          console.log(`  \x1b[32m✅ 工作流完成\x1b[0m`);
          if (result.error) console.log(`  \x1b[33m${result.error}\x1b[0m`);
        }
      } else {
        console.log(`  \x1b[31m❌ 恢复失败: ${result.error ?? "未知错误"}\x1b[0m`);
        process.exit(1);
      }
    } catch (err: any) {
      console.log(`  \x1b[31m❌ 恢复失败: ${err.message}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // resume path (failed, waiting_human, editing)
  try {
    const { makeResumeFlowV2 } = await import("./engine.js");
    const { makeSpawnAgent } = await import("./pm.js");
    const resumeFlow = makeResumeFlowV2(makeSpawnAgent());
    const result = await resumeFlow(s, runId);
    if (result.status === "done") console.log(`  \x1b[32m✅ 工作流完成\x1b[0m`);
    else if (result.status === "waiting_human") console.log(`  \x1b[33m⏳ 等待人工审批\x1b[0m`);
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 恢复失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

// ─── propose / discard ───────────────────────────────────────

export async function cmdFlowPropose(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  try {
    const { propose } = await import("./edit.js");
    const result = await propose(s, runId);
    if (result.ok) {
      console.log(`  \x1b[32m✅ 已申请修改\x1b[0m`);
      const m = s.loadMeta(runId);
      if (m.status === "editing") {
        console.log(`  状态: editing — 可修改图或状态`);
        console.log(`  提交: ptl flow resume ${runId.slice(0, 8)}`);
        console.log(`  放弃: ptl flow discard ${runId.slice(0, 8)}`);
      } else if (m.editRequested) {
        console.log(`  状态: running (将在波边界停波)`);
      }
    } else {
      console.log(`  \x1b[31m❌ ${result.error}\x1b[0m`);
      process.exit(1);
    }
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 申请失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdFlowDiscard(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  try {
    const { discard } = await import("./edit.js");
    const result = await discard(s, runId);
    if (result.ok) {
      console.log(`  \x1b[32m✅ 已放弃修改\x1b[0m`);
    } else {
      console.log(`  \x1b[31m❌ ${result.error}\x1b[0m`);
      process.exit(1);
    }
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 放弃失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

// ─── edit ────────────────────────────────────────────────────

export async function cmdFlowEdit(runId: string): Promise<void> {
  const s = store();
  runId = requireRun(s, runId);
  const result = await editGraph(s, runId);
  if (!result.ok) {
    console.log(`  \x1b[31m❌ 编辑失败: ${result.error}\x1b[0m`);
    console.log("  可先运行 ptl flow show <runId> 查看当前图定义");
    if (result.error && result.error.includes("临时文件")) console.log(`  ${result.error}`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✅ 图已更新（版本 ${s.loadMeta(runId).graphVersion}）\x1b[0m`);
}

// ─── set ─────────────────────────────────────────────────────

export async function cmdFlowSet(runId: string, pathStr: string, rawValue: string): Promise<void> {
  if (!pathStr || rawValue === undefined) {
    console.log("  用法: ptl flow set <runId> <path> <value>");
    console.log("  示例: ptl flow set abc12345 nodes.2.prompt \"新的提示\"");
    console.log("   路径: nodes.N.x / edges.N.x / entry / state.x.y");
    process.exit(1);
  }

  const s = store();
  runId = requireRun(s, runId);
  const result = await setValue(s, runId, pathStr, rawValue);
  if (!result.ok) {
    console.log(`  \x1b[31m❌ 设置失败: ${result.error}\x1b[0m`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✅ ${pathStr} = ${rawValue}\x1b[0m`);
}

// ─── graph ───────────────────────────────────────────────────

export function cmdFlowGraph(runId: string): void {
  const s = store();
  runId = requireRun(s, runId);
  const def = s.loadGraph(runId);

  console.log(`  \x1b[1m当前图 (v${s.loadMeta(runId).graphVersion})\x1b[0m`);
  console.log(`  entry: ${def.entry}`);
  console.log(`  maxSteps: ${def.maxSteps ?? 100}`);
  console.log(`  节点 (${def.nodes.length}):`);
  for (const n of def.nodes) {
    const type = n.type === "human" ? "👤" : "🤖";
    console.log(`    ${type} ${n.id}  (${n.type})`);
  }
  console.log(`  边 (${def.edges.length}):`);
  for (const e of def.edges) {
    const cond = e.when ? `  [${e.when}]` : "";
    console.log(`    ${e.from} → ${e.to}${cond}`);
  }

  // history
  const hist = s.listGraphHistory(runId);
  if (hist.length > 0) {
    console.log(`\n  \x1b[2m修改历史 (${hist.length} 版本):\x1b[0m`);
    for (const v of hist.slice(-5)) {
      console.log(`    v${v.version}  ${formatDate(v.createdAt)}`);
    }
  }
}

// ─── rm ──────────────────────────────────────────────────────

export function cmdFlowRm(runId: string): void {
  const s = store();
  if (!runId) { console.log("  \x1b[31m❌ 缺少 runId\x1b[0m"); process.exit(1); }
  const resolved = resolveRunId(s, runId);
  const ok = s.removeRun(resolved);
  if (ok) {
    console.log(`  \x1b[32m✅ 已删除 ${resolved.slice(0, 8)}…\x1b[0m`);
  } else {
    console.log(`  \x1b[31m❌ 无法删除（running/waiting 状态拒删）\x1b[0m`);
    process.exit(1);
  }
}

// ─── validate ────────────────────────────────────────────────

export function cmdFlowValidate(filePath: string): void {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.log(`  \x1b[31m❌ 文件不存在: ${abs}\x1b[0m`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(abs, "utf-8"));
  const vr = validateFlow(raw);
  if (!vr.ok) {
    console.log(`  \x1b[31m❌ 校验失败 (${vr.errors.length} 错误):\x1b[0m`);
    for (const err of vr.errors) console.log(`    - ${err}`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✅ 校验通过\x1b[0m`);
  if (vr.warnings.length > 0) {
    for (const w of vr.warnings) console.log(`  \x1b[33m⚠️  ${w}\x1b[0m`);
  }
  console.log(`  节点: ${vr.def.nodes.length} 个 · 边: ${vr.def.edges.length} 个`);
  console.log(`  entry: ${vr.def.entry}  ·  maxSteps: ${vr.def.maxSteps ?? 100}`);
}
